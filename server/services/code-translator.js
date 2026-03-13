'use strict';

/**
 * Code Translator — converts compiled Mermaid diagrams into TLA+, TSX, and Rust.
 *
 * Uses the inference provider chain (premium API → Ollama → enhancer) to translate
 * the structured Mermaid source + architecture facts into formal specifications,
 * React components, and Rust type systems.
 */

const { infer, inferMax, isMaxAvailable } = require('./inference-provider');
const logger = require('../utils/logger');

// ---- Target language definitions -------------------------------------------

const TARGETS = {
  'tla+': {
    name: 'TLA+',
    extension: '.tla',
    description: 'Formal specification in TLA+ (Temporal Logic of Actions)',
  },
  tsx: {
    name: 'TSX',
    extension: '.tsx',
    description: 'React TypeScript component hierarchy',
  },
  rust: {
    name: 'Rust',
    extension: '.rs',
    description: 'Rust types, traits, and module structure',
  },
};

// ---- System prompts per target ---------------------------------------------

function buildTranslatePrompt(target) {
  const base = `You are a code generation engine that translates architecture diagrams into production-quality source code. You receive Mermaid diagram source and optionally structured architecture facts (entities, relationships, boundaries). Your output is ONLY valid source code — no prose, no markdown fencing, no explanation outside code comments.`;

  switch (target) {
    case 'tla+':
      return {
        system: [
          base,
          '',
          'TARGET: TLA+ formal specification.',
          '',
          'TRANSLATION RULES:',
          '- Each Mermaid node → a TLA+ variable or constant.',
          '- Each Mermaid subgraph → a TLA+ module or separate specification block.',
          '- Each Mermaid edge → a TLA+ action or state transition.',
          '- Solid edges (-->) → synchronous actions with preconditions and postconditions.',
          '- Dashed edges (-.->) → asynchronous message passing (channels / message queues).',
          '- Thick edges (==>) → critical-path invariants that must be verified.',
          '- Diamond decision nodes → IF/ELSE branching in actions.',
          '- Cylinder data stores → state variables with type constraints.',
          '- External systems (hexagons) → CONSTANTS with type annotations.',
          '',
          'STRUCTURE:',
          '- EXTENDS Sequences, FiniteSets, Naturals, TLC as needed.',
          '- CONSTANTS for external systems and configuration.',
          '- VARIABLES for all stateful components (services, stores, queues).',
          '- TypeInvariant for all variable type constraints.',
          '- Init for initial state.',
          '- One action per edge/relationship.',
          '- Next as disjunction of all actions.',
          '- Safety invariants derived from critical paths.',
          '- Liveness properties for async flows (eventual delivery).',
          '- Fairness conditions on actions that must eventually execute.',
          '',
          'OUTPUT: Valid TLA+ specification. Include module header, extends, constants, variables, operators, Init, Next, Spec, and invariants.',
        ].join('\n'),
        temperature: 0.0,
      };

    case 'tsx':
      return {
        system: [
          base,
          '',
          'TARGET: React TypeScript (TSX) component hierarchy.',
          '',
          'TRANSLATION RULES:',
          '- Each Mermaid subgraph → a React component that acts as a layout container.',
          '- Each Mermaid node → a typed interface/type + a React component.',
          '- Each Mermaid edge → a prop callback, context consumer, or event handler.',
          '- Solid edges → synchronous prop drilling or context consumption.',
          '- Dashed edges → async operations (useEffect, useMutation, event emitters).',
          '- Thick edges → primary data flow highlighted with comments.',
          '- Diamond decision nodes → conditional rendering or route guards.',
          '- Cylinder data stores → custom hooks (useXxxStore) with state management.',
          '- External systems → API client modules with typed request/response.',
          '',
          'STRUCTURE:',
          '- TypeScript strict mode, functional components only.',
          '- Named exports for all components.',
          '- Interface/type definitions at top of file for all entities.',
          '- Props interfaces for each component.',
          '- Custom hooks for data stores and async operations.',
          '- Component tree mirrors the subgraph hierarchy.',
          '- Use React.FC with explicit props typing.',
          '- Include JSDoc comments mapping back to architecture entities.',
          '- Tailwind CSS class placeholders for layout (flex, grid).',
          '',
          'OUTPUT: Single .tsx file with all types, hooks, and components. Ready to drop into a React project.',
        ].join('\n'),
        temperature: 0.0,
      };

    case 'rust':
      return {
        system: [
          base,
          '',
          'TARGET: Rust types, traits, and module structure.',
          '',
          'TRANSLATION RULES:',
          '- Each Mermaid subgraph → a Rust module (mod block).',
          '- Each Mermaid node → a Rust struct or enum variant.',
          '- Each Mermaid edge → a trait method, impl block method, or From/Into conversion.',
          '- Solid edges → synchronous method calls (fn → Result<T, E>).',
          '- Dashed edges → async trait methods (async fn → Result<T, E>) or channel sends.',
          '- Thick edges → critical path methods marked with /// CRITICAL PATH doc comment.',
          '- Diamond decision nodes → enum variants with match arms.',
          '- Cylinder data stores → trait definitions (Repository pattern) with async CRUD.',
          '- External systems → trait definitions for dependency injection.',
          '- Stadium actors → structs implementing Handler traits.',
          '',
          'STRUCTURE:',
          '- Rust 2021 edition conventions.',
          '- #[derive(Debug, Clone)] on all structs.',
          '- thiserror for error types, one Error enum per module.',
          '- Traits for all cross-boundary interactions (dependency injection).',
          '- Async trait methods where edges are dashed.',
          '- Builder pattern for complex entity construction.',
          '- Type aliases for common Result types.',
          '- Module hierarchy mirrors subgraph nesting.',
          '- Doc comments (///) on all public items mapping back to architecture.',
          '',
          'OUTPUT: Single .rs file with mod blocks, traits, structs, impls, and error types. Compiles with `cargo check` (no external crate implementations, just the type skeleton).',
        ].join('\n'),
        temperature: 0.0,
      };

    default:
      throw new Error(`Unknown translation target: ${target}`);
  }
}

// ---- Translation entry point -----------------------------------------------

/**
 * Translate compiled Mermaid source into target language code.
 *
 * @param {object} opts
 * @param {string} opts.mmdSource - Compiled Mermaid source
 * @param {string} opts.target - Target language: 'tla+', 'tsx', 'rust'
 * @param {object} [opts.facts] - Architecture facts (entities, relationships, boundaries)
 * @param {string} [opts.description] - Original architecture description
 * @param {boolean} [opts.maxMode] - Use strongest model
 * @returns {Promise<{success: boolean, code?: string, target: string, provider?: string, error?: string}>}
 */
async function translate(opts) {
  const { mmdSource, target, facts, description, maxMode } = opts;

  if (!mmdSource || !target) {
    return { success: false, target: target || 'unknown', error: 'mmdSource and target are required' };
  }

  const targetLower = target.toLowerCase();
  if (!TARGETS[targetLower]) {
    return {
      success: false,
      target,
      error: `Unknown target "${target}". Supported: ${Object.keys(TARGETS).join(', ')}`,
    };
  }

  const promptConfig = buildTranslatePrompt(targetLower);

  // Build user prompt with all available context
  const userParts = [];

  if (description) {
    userParts.push('[ARCHITECTURE DESCRIPTION]');
    userParts.push(description.slice(0, 3000));
    userParts.push('');
  }

  userParts.push('[MERMAID DIAGRAM SOURCE]');
  userParts.push(mmdSource);
  userParts.push('');

  if (facts) {
    userParts.push('[ARCHITECTURE FACTS]');
    userParts.push(JSON.stringify(facts, null, 2));
    userParts.push('');
  }

  userParts.push(`Translate this architecture into ${TARGETS[targetLower].description}. Return ONLY the source code.`);

  const userPrompt = userParts.join('\n');

  const startMs = Date.now();

  try {
    const useMax = maxMode && isMaxAvailable();
    const result = useMax
      ? await inferMax('translate', { systemPrompt: promptConfig.system, userPrompt })
      : await infer('translate', { systemPrompt: promptConfig.system, userPrompt });

    if (!result.output) {
      logger.warn('translate.no_output', { target: targetLower });
      return { success: false, target: targetLower, error: 'No provider could generate code' };
    }

    // Strip markdown fencing if the model wrapped it
    let code = result.output;
    const fenceMatch = code.match(/^```(?:tla\+?|tsx|typescript|rust|rs)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) {
      code = fenceMatch[1];
    }

    const elapsed = Date.now() - startMs;
    logger.info('translate.success', {
      target: targetLower,
      provider: result.provider,
      codeLen: code.length,
      elapsed,
    });

    return {
      success: true,
      code,
      target: targetLower,
      targetInfo: TARGETS[targetLower],
      provider: result.provider,
      elapsed,
    };
  } catch (err) {
    logger.error('translate.error', { target: targetLower, error: err.message });
    return { success: false, target: targetLower, error: err.message };
  }
}

/**
 * Get available translation targets.
 */
function getTargets() {
  return { ...TARGETS };
}

module.exports = { translate, getTargets, TARGETS };
