'use strict';

const { Router } = require('express');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { archive, archiveCompiled } = require('../services/mermaid-archiver');
const { validate: validateMmd } = require('../services/mermaid-validator');
const { route, renderPrepare, renderHPCGoT, renderMaxUpgrade, decomposeAndRender, compileWithRetry, RouterError } = require('../services/input-router');
const enhancerBridge = require('../services/gpt-enhancer-bridge');
const provider = require('../services/inference-provider');
const visualProvider = require('../services/visual-provider');
const codeTranslator = require('../services/code-translator');
const { buildPrompt } = require('../services/axiom-prompts');
const { analyze } = require('../services/input-analyzer');
const { deriveDiagramName } = require('../utils/naming');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(PROJECT_ROOT, 'flows');
const ENHANCER_URL = process.env.MERMAID_ENHANCER_URL || 'http://localhost:8100';
const ENHANCER_TIMEOUT_MS = parseInt(process.env.MERMAID_ENHANCER_TIMEOUT || '15000', 10);

const router = Router();
const COPILOT_STAGES = new Set(['copilot_suggest', 'copilot_enhance']);

async function callEnhancer(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCER_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENHANCER_URL}/mermaid/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/copilot/health
 * Frontend-safe health probe: reports available if ANY provider in the chain
 * can serve copilot requests (Ollama, premium API, or Python enhancer).
 */
router.get('/copilot/health', async (_req, res) => {
  try {
    const providers = await provider.checkProviders();
    const available = providers.ollama || providers.premium || providers.enhancer;
    const maxAvailable = provider.isMaxAvailable();
    const visualAvailable = visualProvider.isAvailable();
    return res.status(available ? 200 : 503).json({
      success: available,
      available,
      providers,
      maxAvailable,
      visual: visualAvailable,
    });
  } catch (err) {
    logger.warn('copilot.health.error', { error: err.message });
    return res.status(503).json({
      success: false,
      available: false,
    });
  }
});

/**
 * GET /api/visual/styles
 * Returns available visual style presets for the Gemini visualization layer.
 */
router.get('/visual/styles', (_req, res) => {
  return res.json({
    success: true,
    available: visualProvider.isAvailable(),
    styles: visualProvider.getStyles(),
    default_style: process.env.GEMINI_VISUAL_STYLE || 'tech-dark',
  });
});

/**
 * POST /api/analyze
 * Returns an InputProfile for the given text — maturity, quality, completeness,
 * intent, shadow model, recommendation, and hint. Called by the frontend on
 * debounced input changes to power intelligent suggestion gating and hints.
 */
router.post('/analyze', (req, res) => {
  const text = req.body?.text;
  const mode = req.body?.mode || 'idea';
  if (!text || typeof text !== 'string') {
    return res.json({ success: true, profile: analyze('', mode) });
  }
  const profile = analyze(text.trim(), mode);
  return res.json({ success: true, profile });
});

/**
 * POST /api/copilot/enhance
 * Proxies copilot suggest/enhance requests to enhancer service.
 */
router.post('/copilot/enhance', async (req, res) => {
  const stage = req.body?.stage;
  if (!COPILOT_STAGES.has(stage)) {
    return res.status(400).json({
      success: false,
      error: 'invalid_stage',
      details: 'stage must be copilot_suggest or copilot_enhance',
    });
  }

  const prompt = buildPrompt(stage);

  // Compute shadow model for context injection into copilot enhance calls
  const sourceText = req.body?.full_text || req.body?.raw_source || '';
  let shadowContext = null;
  if (stage === 'copilot_enhance' && sourceText) {
    const profile = analyze(sourceText, 'idea');
    shadowContext = {
      entities: (profile.shadow?.entities || []).slice(0, 20).map(e => e.name),
      relationships: (profile.shadow?.relationships || []).slice(0, 15).map(r => `${r.from} ${r.verb} ${r.to}`),
      gaps: profile.shadow?.gaps || [],
      maturity: profile.maturity,
      qualityScore: profile.qualityScore,
    };
  }

  // Try the Python enhancer first, then fall through to the provider chain
  const enhancerAvailable = await enhancerBridge.isAvailable();
  if (enhancerAvailable) {
    const payload = {
      ...req.body,
      stage,
      content_state: req.body?.content_state || 'text',
      mode: req.body?.mode || 'idea',
      raw_source: req.body?.raw_source || req.body?.full_text || '',
      system_prompt: prompt.system,
      temperature: prompt.temperature,
      ...(shadowContext ? { shadow_context: shadowContext } : {}),
    };

    try {
      const upstream = await callEnhancer(payload);
      const responseText = await upstream.text();
      let data = null;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = null;
      }

      if (upstream.ok && data) {
        // No-op detection for copilot_enhance
        if (stage === 'copilot_enhance') {
          const inputText = (req.body?.selected_text || req.body?.full_text || req.body?.raw_source || '').trim();
          const outputText = (data.enhanced_source || '').trim();
          if (!inputText || !outputText || inputText !== outputText) {
            return res.json({ success: true, ...data });
          }
          logger.warn('copilot.enhance.no_op_enhancer', { stage });
          // Fall through to provider chain below
        } else if (stage === 'copilot_suggest') {
          const suggestion = (data.suggestion || '').trim();
          const confidence = data.confidence || 'low';
          if (suggestion || confidence === 'low') {
            return res.json({ success: true, ...data });
          }
          logger.warn('copilot.suggest.empty_enhancer', { stage });
          // Fall through to provider chain below
        } else {
          return res.json({ success: true, ...data });
        }
      }
    } catch (err) {
      logger.warn('copilot.enhancer_failed', { stage, error: err.message });
    }
  }

  // ---- Provider chain fallback (Ollama / premium API) ----
  // Build a user prompt that includes shadow context
  let userPrompt = sourceText;
  if (shadowContext) {
    const contextLines = [];
    if (shadowContext.entities.length > 0) contextLines.push(`[ENTITIES] ${shadowContext.entities.join(', ')}`);
    if (shadowContext.relationships.length > 0) contextLines.push(`[RELATIONSHIPS] ${shadowContext.relationships.join('; ')}`);
    if (shadowContext.gaps.length > 0) contextLines.push(`[GAPS] ${shadowContext.gaps.join('; ')}`);
    if (contextLines.length > 0) userPrompt = contextLines.join('\n') + '\n\n' + sourceText;
  }

  if (stage === 'copilot_suggest') {
    const activeLine = req.body?.active_line || '';
    const suggestUserPrompt = `Stage: copilot_suggest\n\nFull text: ${sourceText}\n\nActive line: ${activeLine}\n\nReturn valid JSON only.`;
    const result = await provider.infer('copilot_suggest', {
      systemPrompt: prompt.system,
      userPrompt: suggestUserPrompt,
    });

    if (result.output) {
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.suggestion) return res.json({ success: true, ...parsed, provider: result.provider });
      } catch {
        // Not valid JSON — treat as raw suggestion text
        if (result.output.length <= 120) {
          return res.json({ success: true, suggestion: result.output.trim(), confidence: 'medium', provider: result.provider });
        }
      }
    }
    return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No provider could generate a suggestion.' });
  }

  if (stage === 'copilot_enhance') {
    const enhanceUserPrompt = `Stage: copilot_enhance\nEnhance mode: ${req.body?.enhance_mode || 'full'}\n\nFull text: ${sourceText}\n\nSelected text: ${req.body?.selected_text || ''}\n\nReturn valid JSON only.`;
    const result = await provider.infer('copilot_enhance', {
      systemPrompt: prompt.system,
      userPrompt: enhanceUserPrompt,
    });

    if (result.output && !result.noOp) {
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.enhanced_source) return res.json({ success: true, ...parsed, provider: result.provider });
      } catch {
        // Not JSON — use raw text as enhanced source
        return res.json({
          success: true,
          enhanced_source: result.output.trim(),
          intent_preserved: true,
          provider: result.provider,
        });
      }
    }
    return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No provider could enhance the text.' });
  }

  return res.status(503).json({ success: false, error: 'copilot_unavailable', details: 'No copilot provider available.' });
});

/**
 * POST /api/render
 * Body: { mermaid_source: string, diagram_name?: string, enhance?: boolean }
 *
 * Accepts plain text, markdown, mermaid source, or hybrid content.
 * The input-router detects the content type and selects the correct pipeline.
 */
router.post('/render', async (req, res) => {
  const { mermaid_source, diagram_name, enhance, max_mode, input_mode, visual, visual_style } = req.body || {};

  if (!mermaid_source || typeof mermaid_source !== 'string' || !mermaid_source.trim()) {
    return res.status(400).json({
      success: false,
      error: 'missing_source',
      details: 'mermaid_source is required and must be a non-empty string',
    });
  }

  const source = mermaid_source.trim();

  if (source.length > 100_000) {
    return res.status(400).json({
      success: false,
      error: 'input_too_large',
      details: 'Input exceeds 100,000 characters',
    });
  }

  try {
    const classifiedAt = new Date().toISOString();
    const startMs = Date.now();

    // 1. Analyze input holistically (maturity, quality, shadow model, intent)
    const profile = analyze(source, input_mode || 'idea');

    const maxRequested = !!(max_mode && provider.isMaxAvailable());
    let useMax = maxRequested;

    logger.info('render.analyzed', {
      maturity: profile.maturity,
      quality: profile.qualityScore,
      completeness: profile.completenessScore,
      recommendation: profile.recommendation,
      contentState: profile.contentState,
      complexity: profile.complexity,
      shouldDecompose: profile.shouldDecompose,
      maxMode: useMax,
    });

    // 2. Choose pipeline based on content state and profile recommendation
    let routeResult;
    const isTextOrMd = profile.contentState === 'text' || profile.contentState === 'md';
    const shouldUseProvider = isTextOrMd && enhance;

    if (shouldUseProvider) {
      // ---- Provider-backed render: HPC-GoT bounded pipeline ----
      const wantsDecompose = profile.shouldDecompose;
      const strongEnoughForSingleShot = profile.qualityScore >= 0.6
        && (profile.shadow?.entities?.length || 0) <= 15
        && profile.completenessScore >= 0.5;
      const useDecompose = wantsDecompose && !strongEnoughForSingleShot;

      // Decide whether the input is rich enough to benefit from the
      // 3-stage HPC-GoT pipeline (fact→plan→compose). Simple ideas are
      // faster and more reliable with the single-shot renderPrepare path.
      const entityCount = profile.shadow?.entities?.length || 0;
      const useHPCGoT = !useDecompose && !maxRequested
        && (profile.complexity >= 0.15 || entityCount >= 5);

      const pipelineName = useDecompose ? 'decompose'
        : maxRequested ? 'max_upgrade'
        : useHPCGoT ? 'hpc_got'
        : 'render_prepare';

      logger.info('render.routing', {
        pipeline: pipelineName,
        shouldDecompose: wantsDecompose,
        strongEnoughForSingleShot,
        useDecompose,
        useHPCGoT,
        entityCount,
        complexity: profile.complexity,
        quality: profile.qualityScore,
        completeness: profile.completenessScore,
      });

      let prepResult;
      if (useDecompose) {
        prepResult = await decomposeAndRender(source, profile, maxRequested);
      } else if (maxRequested) {
        // Max mode: always run the full Max upgrade pipeline.
        // No gate — the user explicitly asked for Max. renderMaxUpgrade
        // runs normal HPC-GoT internally as baseline, then recomposes
        // via the strongest model with an architect-grade prompt.
        prepResult = await renderMaxUpgrade(source, profile);
      } else if (useHPCGoT) {
        prepResult = await renderHPCGoT(source, profile, false);
      } else {
        // Simple idea: single-shot render is faster and more reliable
        prepResult = await renderPrepare(source, profile, false);
      }

      routeResult = {
        mmdSource: prepResult.mmdSource,
        diagramType: '',
        contentState: profile.contentState,
        enhanced: prepResult.enhanced,
        enhanceMeta: prepResult.enhanced ? {
          transformation: pipelineName,
          provider: prepResult.provider,
          hpcScore: prepResult.hpcScore || null,
        } : null,
        stagesExecuted: prepResult.stagesExecuted,
        totalEnhanceMs: Date.now() - startMs,
        validation: null,
        diagramSelection: profile.diagramSelection,
      };
    } else {
      // ---- Existing route() for mmd, hybrid, and non-enhance paths ----
      try {
        routeResult = await route(source, { enhance: !!enhance });
      } catch (err) {
        if (err instanceof RouterError) {
          return res.status(422).json({
            success: false,
            error: err.code,
            details: err.message,
          });
        }
        throw err;
      }
    }

    const {
      mmdSource,
      contentState,
      enhanced: wasEnhanced,
      enhanceMeta,
      stagesExecuted,
      totalEnhanceMs,
      validation: preCompileValidation,
      diagramSelection,
    } = routeResult;

    // Re-classify after potential transformation
    const diagramType = routeResult.diagramType || require('../services/mermaid-classifier').classify(mmdSource);

    logger.info('input.routed', {
      content_state: contentState,
      diagram_type: diagramType,
      enhanced: wasEnhanced,
      stages: stagesExecuted,
      enhance_ms: totalEnhanceMs,
    });

    // 3. Derive name
    const diagramName = deriveDiagramName(mmdSource, diagram_name);

    // 4. Archive original source
    const archivePaths = await archive(source, diagramName, diagramType);

    // 5. Compile with retry loop (deterministic repair -> model-assisted repair)
    const outputDir = path.join(FLOWS_DIR, diagramName);
    const compileOutcome = await compileWithRetry(mmdSource, outputDir, diagramName);

    if (!compileOutcome.result.ok) {
      return res.status(422).json({
        success: false,
        error: 'compilation_failed',
        details: _sanitizeError(compileOutcome.result.error),
        diagram_type: diagramType,
        content_state: contentState,
        attempts: compileOutcome.attempts,
        repair_changes: compileOutcome.repairChanges,
        enhance_meta: wasEnhanced ? {
          transformation: enhanceMeta?.transformation,
          content_state: contentState,
          stages_executed: stagesExecuted,
          total_enhance_ms: totalEnhanceMs,
        } : null,
      });
    }

    // 6. Post-render: archive compiled Mermaid and compute quality metrics
    const compiledAt = new Date().toISOString();
    const finalMmd = compileOutcome.mmdSource;
    const finalDiagramType = require('../services/mermaid-classifier').classify(finalMmd);

    const compiledArchivePath = await archiveCompiled(finalMmd, diagramName, {
      provider: enhanceMeta?.provider || null,
      attempts: compileOutcome.attempts,
      maxMode: useMax,
    });

    const postRenderValidation = validateMmd(finalMmd);
    const mmdMetrics = {
      nodeCount: postRenderValidation.stats?.nodeCount || 0,
      edgeCount: postRenderValidation.stats?.edgeCount || 0,
      subgraphCount: postRenderValidation.stats?.subgraphCount || 0,
      charCount: finalMmd.length,
      structurallyValid: postRenderValidation.valid,
    };

    // 7. Optional: generate polished visual via Gemini (nanobanana layer)
    let visualResult = null;
    if (visual && visualProvider.isAvailable()) {
      try {
        const entities = (profile.shadow?.entities || []).map(e => e.name);
        const relationships = (profile.shadow?.relationships || []).map(r => `${r.from} ${r.verb} ${r.to}`);

        visualResult = await visualProvider.render({
          description: source,
          diagramName,
          outputDir: outputDir,
          diagramType: finalDiagramType || diagramType,
          title: diagram_name || diagramName,
          style: visual_style || undefined,
          entities,
          relationships,
        });
      } catch (err) {
        logger.warn('render.visual.error', { error: err.message });
        visualResult = { success: false, error: err.message };
      }
    }

    // 8. Respond with final artifacts + compiled source + quality metrics
    return res.json({
      success: true,
      diagram_name: diagramName,
      diagram_type: finalDiagramType || diagramType,
      classified_at: classifiedAt,
      compiled_at: compiledAt,
      enhanced: wasEnhanced,
      enhance_meta: wasEnhanced ? {
        transformation: enhanceMeta?.transformation,
        content_state: contentState,
        maturity: enhanceMeta?.maturity || profile.maturity,
        stages_executed: stagesExecuted,
        total_enhance_ms: totalEnhanceMs,
        warnings: enhanceMeta?.warnings || [],
        provider: enhanceMeta?.provider || null,
      } : null,
      content_state: contentState,
      paths: {
        png: `/flows/${diagramName}/${diagramName}.png`,
        svg: `/flows/${diagramName}/${diagramName}.svg`,
        visual: visualResult?.success ? `/flows/${diagramName}/${diagramName}-visual.png` : null,
        mmd: archivePaths.mmdPath,
        md: archivePaths.mdPath,
        compiled_mmd: compiledArchivePath,
      },
      compiled_source: finalMmd,
      visual: visualResult ? {
        success: visualResult.success,
        style: visualResult.style || null,
        error: visualResult.error || null,
      } : null,
      validation: {
        svg_valid: compileOutcome.result.svg.valid,
        png_valid: compileOutcome.result.png.valid,
        svg_bytes: compileOutcome.result.svg.bytes,
        png_bytes: compileOutcome.result.png.bytes,
      },
      render_meta: {
        attempts: compileOutcome.attempts,
        repair_changes: compileOutcome.repairChanges,
        max_mode: useMax,
      },
      mmd_metrics: mmdMetrics,
      axiom_analysis: {
        pre_compile: {
          valid: preCompileValidation?.valid ?? true,
          errors: (preCompileValidation?.errors || []).length,
          warnings: (preCompileValidation?.warnings || []).length,
          stats: preCompileValidation?.stats || {},
        },
        diagram_selection: diagramSelection || profile.diagramSelection || null,
      },
    });
  } catch (err) {
    logger.error('render.error', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      details: 'An internal error occurred while rendering the diagram',
    });
  }
});

/**
 * GET /api/diagrams
 * Returns list of previously rendered diagrams from flows/.
 */
router.get('/diagrams', async (_req, res) => {
  try {
    await fsp.mkdir(FLOWS_DIR, { recursive: true });
    const entries = await fsp.readdir(FLOWS_DIR, { withFileTypes: true });
    const diagrams = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const dirPath = path.join(FLOWS_DIR, name);
      const files = await fsp.readdir(dirPath);
      const hasPng = files.some(f => f.endsWith('.png'));
      const hasSvg = files.some(f => f.endsWith('.svg'));
      if (hasPng || hasSvg) {
        const stat = await fsp.stat(dirPath);
        diagrams.push({
          name,
          has_png: hasPng,
          has_svg: hasSvg,
          paths: {
            png: hasPng ? `/flows/${name}/${name}.png` : null,
            svg: hasSvg ? `/flows/${name}/${name}.svg` : null,
          },
          created_at: stat.birthtime.toISOString(),
        });
      }
    }

    diagrams.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return res.json({ success: true, diagrams });
  } catch (err) {
    logger.error('diagrams.list.error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to list diagrams' });
  }
});

/**
 * DELETE /api/diagrams/:name
 * Remove a diagram's compiled outputs and archived source.
 */
router.delete('/diagrams/:name', async (req, res) => {
  const name = req.params.name;
  if (!name || /[\/\\]/.test(name)) {
    return res.status(400).json({ success: false, error: 'invalid_name' });
  }

  try {
    const flowDir = path.join(FLOWS_DIR, name);
    await fsp.rm(flowDir, { recursive: true, force: true }).catch(() => {});

    const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');
    const mmdPath = path.join(ARCHS_DIR, `${name}.mmd`);
    await fsp.rm(mmdPath, { force: true }).catch(() => {});

    const mdFiles = await fsp.readdir(ARCHS_DIR).catch(() => []);
    for (const f of mdFiles) {
      if (f.endsWith(`-${name}.md`)) {
        await fsp.rm(path.join(ARCHS_DIR, f), { force: true }).catch(() => {});
      }
    }

    logger.info('diagram.deleted', { name });
    return res.json({ success: true });
  } catch (err) {
    logger.error('diagram.delete.error', { name, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to delete diagram' });
  }
});

/**
 * PATCH /api/diagrams/:name
 * Rename a diagram's folder, compiled outputs, and archived sources.
 */
router.patch('/diagrams/:name', async (req, res) => {
  const oldName = req.params.name;
  const newNameRaw = req.body?.new_name;
  if (!oldName || /[\/\\]/.test(oldName)) {
    return res.status(400).json({ success: false, error: 'invalid_name' });
  }
  if (!newNameRaw || typeof newNameRaw !== 'string' || !newNameRaw.trim()) {
    return res.status(400).json({ success: false, error: 'new_name is required' });
  }

  const { slugify } = require('../utils/naming');
  if (newNameRaw.length > 200) {
    return res.status(400).json({ success: false, error: 'new_name too long (max 200 chars)' });
  }
  const newName = slugify(newNameRaw.trim());
  if (!newName || newName.length < 2) {
    return res.status(400).json({ success: false, error: 'new_name too short' });
  }
  if (newName === oldName) {
    return res.json({ success: true, new_name: oldName, paths: { png: `/flows/${oldName}/${oldName}.png`, svg: `/flows/${oldName}/${oldName}.svg` } });
  }

  try {
    const oldFlowDir = path.join(FLOWS_DIR, oldName);
    const newFlowDir = path.join(FLOWS_DIR, newName);

    const oldExists = await fsp.stat(oldFlowDir).then(() => true).catch(() => false);
    if (oldExists) {
      await fsp.rename(oldFlowDir, newFlowDir);
      const files = await fsp.readdir(newFlowDir);
      for (const f of files) {
        if (f.startsWith(oldName)) {
          const suffix = f.slice(oldName.length);
          await fsp.rename(path.join(newFlowDir, f), path.join(newFlowDir, newName + suffix));
        }
      }
    }

    const ARCHS_DIR = path.join(PROJECT_ROOT, 'archs');
    const oldMmd = path.join(ARCHS_DIR, `${oldName}.mmd`);
    const newMmd = path.join(ARCHS_DIR, `${newName}.mmd`);
    await fsp.rename(oldMmd, newMmd).catch(() => {});

    const archFiles = await fsp.readdir(ARCHS_DIR).catch(() => []);
    for (const f of archFiles) {
      if (f.endsWith(`-${oldName}.md`)) {
        const newF = f.replace(`-${oldName}.md`, `-${newName}.md`);
        await fsp.rename(path.join(ARCHS_DIR, f), path.join(ARCHS_DIR, newF)).catch(() => {});
      }
    }

    logger.info('diagram.renamed', { oldName, newName });
    return res.json({
      success: true,
      new_name: newName,
      paths: {
        png: `/flows/${newName}/${newName}.png`,
        svg: `/flows/${newName}/${newName}.svg`,
      },
    });
  } catch (err) {
    logger.error('diagram.rename.error', { oldName, newName, error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to rename diagram' });
  }
});

/**
 * GET /api/translate/targets
 * Returns available code translation targets (TLA+, TSX, Rust).
 */
router.get('/translate/targets', (_req, res) => {
  return res.json({
    success: true,
    targets: codeTranslator.getTargets(),
  });
});

/**
 * POST /api/translate
 * Translate a Mermaid diagram into TLA+, TSX, or Rust source code.
 * Body: { mermaid_source: string, target: 'tla+' | 'tsx' | 'rust', description?: string, facts?: object, max_mode?: boolean }
 */
router.post('/translate', async (req, res) => {
  const { mermaid_source, target, description, facts, max_mode } = req.body || {};

  if (!mermaid_source || typeof mermaid_source !== 'string' || !mermaid_source.trim()) {
    return res.status(400).json({
      success: false,
      error: 'missing_source',
      details: 'mermaid_source is required',
    });
  }

  if (!target || typeof target !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'missing_target',
      details: 'target is required. Supported: tla+, tsx, rust',
    });
  }

  try {
    const result = await codeTranslator.translate({
      mmdSource: mermaid_source.trim(),
      target: target.trim(),
      description: description || null,
      facts: facts || null,
      maxMode: !!max_mode,
    });

    if (!result.success) {
      return res.status(422).json(result);
    }

    return res.json(result);
  } catch (err) {
    logger.error('translate.route.error', { target, error: err.message });
    return res.status(500).json({ success: false, error: 'Translation failed' });
  }
});

/**
 * Strip environment noise (security-monitor banners, ANSI codes, stack traces)
 * from compiler error messages before returning them to the user.
 */
function _sanitizeError(raw) {
  if (!raw || typeof raw !== 'string') return 'Compilation failed';
  let cleaned = raw
    .replace(/\u001b\[[0-9;]*m/g, '')                        // ANSI escape codes
    .replace(/\[npm-security-monitor\][^\n]*/g, '')           // security-monitor lines
    .replace(/═{3,}[^═]*═{3,}/gs, '')                        // banner blocks
    .replace(/⚠️[^\n]*/g, '')                                // alert headers
    .replace(/Explanation:[\s\S]*?Action Taken:[\s\S]*?\n/g, '') // full alert bodies
    .replace(/•[^\n]*/g, '')                                  // bullet explanations
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')                    // stack trace frames
    .replace(/\n{3,}/g, '\n\n')                               // collapse blank runs
    .trim();
  // Extract the meaningful Mermaid error line
  const mermaidErr = cleaned.match(/((?:UnknownDiagramError|Error|Parse error)[^\n]+)/);
  if (mermaidErr) return mermaidErr[1].trim();
  return cleaned.slice(0, 300) || 'Compilation failed';
}

module.exports = router;
