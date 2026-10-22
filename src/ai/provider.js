// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — YOURS. Call any LLM API you like (Anthropic, OpenAI,
//              Gemini, Ollama, …) with plain fetch(). Read the endpoint,
//              key and model from the VITE_AI_* env vars (.env.example).
//
//  Do not hard-code a vendor anywhere else: everything outside this
//  file must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint || !model) throw new Error('Provider configuration is incomplete: set VITE_AI_ENDPOINT and VITE_AI_MODEL')
            const messages = [{ role: 'system', content: request.system }, ...(request.history || []), { role: 'user', content: request.user }]
            let response
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
                    body: JSON.stringify({ model, messages, temperature: 0 }),
                })
            } catch (error) {
                throw new Error(`Provider network error: ${error.message}`)
            }
            if (!response.ok) {
                const detail = (await response.text()).slice(0, 500)
                const reason = response.status === 401 ? ' authentication' : response.status === 429 ? ' rate limit' : ''
                throw new Error(`Provider request failed (${response.status}${reason}): ${detail || response.statusText}`)
            }
            const payload = await response.json()
            const text = payload.choices?.[0]?.message?.content ?? payload.output_text
            if (typeof text !== 'string') throw new Error('Provider returned an unsupported response envelope')
            return { text, provider: 'http' }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
