'use strict';

/**
 * Visual Provider — Gemini Image Generation layer for Mermate.
 *
 * After Mermate compiles a Mermaid diagram (structural/logical), this service
 * generates a polished, presentation-quality visual version.
 *
 * Two paths for visual generation:
 *   1. Direct Gemini API (fallback) — uses gemini-2.0-flash-exp for image gen
 *   2. Nanobanana MCP (preferred) — use model_tier='pro' for Gemini 3 Pro Image
 *      Call nanobanana's generate_image tool from Claude Code for best quality.
 *
 * Environment variables:
 *   GEMINI_API_KEY          - Google AI Studio API key (required for direct path)
 *   GEMINI_VISUAL_MODEL     - Model ID (default: gemini-2.0-flash-exp)
 *   GEMINI_VISUAL_STYLE     - Default style preset (default: tech-dark)
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_VISUAL_MODEL || 'gemini-2.5-flash-preview-05-20';
const DEFAULT_STYLE = process.env.GEMINI_VISUAL_STYLE || 'tech-dark';
const VISUAL_TIMEOUT_MS = parseInt(process.env.GEMINI_VISUAL_TIMEOUT || '120000', 10);

// ---- Style presets --------------------------------------------------------

const STYLE_PRESETS = {
  'tech-dark': 'Dark tech theme with deep navy/charcoal background, glowing connection lines, subtle depth shadows, rounded rectangles for components. Modern minimalist.',
  'tech-light': 'Clean white/light gray background, crisp blue and teal accents, thin connecting lines, flat design with subtle shadows. Professional and readable.',
  'blueprint': 'Blueprint-style with dark blue background, white/cyan wireframe elements, technical grid overlay, engineering schematic feel.',
  'gradient': 'Vibrant gradient backgrounds (purple to blue), frosted glass component cards, colorful connection lines, modern SaaS aesthetic.',
  'minimal': 'Pure white background, black text, thin gray lines, maximum readability. No decorative elements.',
  'cyberpunk': 'Dark background with neon accents (magenta, cyan, amber), circuit-board traces, high-contrast glowing nodes.',
};

// ---- Prompt builder -------------------------------------------------------

/**
 * Build a Gemini image generation prompt from diagram metadata.
 *
 * @param {object} opts
 * @param {string} opts.description - Plain-text architecture description
 * @param {string} opts.diagramType - Mermaid diagram type (flowchart, sequence, etc.)
 * @param {string} [opts.title] - Diagram title
 * @param {string} [opts.style] - Style preset name or custom style instructions
 * @param {string[]} [opts.entities] - Extracted entity names from shadow model
 * @param {string[]} [opts.relationships] - Extracted relationships
 * @returns {string} The generation prompt
 */
function buildVisualPrompt(opts) {
  const style = STYLE_PRESETS[opts.style] || STYLE_PRESETS[DEFAULT_STYLE] || opts.style || '';

  const parts = [
    'Professional system architecture diagram.',
  ];

  if (opts.title) {
    parts.push(`Title "${opts.title}" at the top in elegant sans-serif.`);
  }

  if (opts.description) {
    parts.push(`Architecture: ${opts.description}`);
  }

  if (opts.entities && opts.entities.length > 0) {
    parts.push(`Key components: ${opts.entities.slice(0, 12).join(', ')}.`);
  }

  if (opts.relationships && opts.relationships.length > 0) {
    parts.push(`Connections: ${opts.relationships.slice(0, 8).join('. ')}.`);
  }

  // Map Mermaid diagram type to visual layout hint
  const layoutHints = {
    flowchart: 'Show as a flowchart with directional arrows between components.',
    sequence: 'Show as a sequence/timeline with participants and message arrows.',
    classDiagram: 'Show as a class/entity relationship diagram with boxes and associations.',
    stateDiagram: 'Show as a state machine with states and transitions.',
    erDiagram: 'Show as an entity-relationship diagram with tables and connections.',
    c4: 'Show as a C4 architecture diagram with containers and boundaries.',
    mindmap: 'Show as a radial mind map with a central node branching outward.',
  };
  if (opts.diagramType && layoutHints[opts.diagramType]) {
    parts.push(layoutHints[opts.diagramType]);
  }

  parts.push(style);
  parts.push('Clean, readable labels. No text clutter. 16:9 aspect ratio.');

  return parts.join(' ');
}

// ---- Gemini API call ------------------------------------------------------

/**
 * Call Gemini image generation API.
 *
 * @param {string} prompt - Image generation prompt
 * @param {string} outputPath - Where to save the generated PNG
 * @returns {Promise<{success: boolean, path?: string, width?: number, height?: number, error?: string}>}
 */
async function generateVisual(prompt, outputPath) {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'GEMINI_API_KEY not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISUAL_TIMEOUT_MS);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          temperature: 1,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn('visual.gemini.http_error', { status: res.status, body: errText.slice(0, 200) });
      return { success: false, error: `Gemini API returned ${res.status}` };
    }

    const data = await res.json();

    // Extract image from response
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return { success: false, error: 'No candidate in Gemini response' };
    }

    const imagePart = candidate.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imagePart) {
      return { success: false, error: 'No image in Gemini response' };
    }

    // Decode and save
    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, imageBuffer);

    logger.info('visual.generated', {
      path: outputPath,
      bytes: imageBuffer.length,
      mime: imagePart.inlineData.mimeType,
    });

    return {
      success: true,
      path: outputPath,
      bytes: imageBuffer.length,
      mimeType: imagePart.inlineData.mimeType,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('visual.gemini.timeout', { timeout: VISUAL_TIMEOUT_MS });
      return { success: false, error: `Gemini timed out after ${VISUAL_TIMEOUT_MS}ms` };
    }
    logger.error('visual.gemini.error', { error: err.message });
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Public API -----------------------------------------------------------

/**
 * Check if the visual provider is available.
 */
function isAvailable() {
  return !!GEMINI_API_KEY;
}

/**
 * Get available style presets.
 */
function getStyles() {
  return { ...STYLE_PRESETS };
}

/**
 * Generate a visual version of a diagram.
 *
 * @param {object} opts
 * @param {string} opts.description - Architecture description (plain text)
 * @param {string} opts.diagramName - Name for the output file
 * @param {string} opts.outputDir - Directory to save into (e.g., flows/my-diagram/)
 * @param {string} [opts.diagramType] - Mermaid diagram type
 * @param {string} [opts.title] - Display title
 * @param {string} [opts.style] - Style preset or custom instructions
 * @param {string[]} [opts.entities] - Entity names from shadow model
 * @param {string[]} [opts.relationships] - Relationship descriptions
 * @returns {Promise<{success: boolean, path?: string, prompt?: string, error?: string}>}
 */
async function render(opts) {
  const prompt = buildVisualPrompt(opts);
  const outputPath = path.join(opts.outputDir, `${opts.diagramName}-visual.png`);

  logger.info('visual.render.start', {
    name: opts.diagramName,
    style: opts.style || DEFAULT_STYLE,
    hasEntities: !!(opts.entities?.length),
  });

  const result = await generateVisual(prompt, outputPath);

  return {
    ...result,
    prompt,
    style: opts.style || DEFAULT_STYLE,
  };
}

module.exports = { render, isAvailable, getStyles, buildVisualPrompt };
