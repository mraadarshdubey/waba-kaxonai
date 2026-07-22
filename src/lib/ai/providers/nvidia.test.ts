import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateNvidia, stripReasoning } from './nvidia'
import { AiError } from '../types'

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

const ARGS = {
  apiKey: 'nvapi-test',
  model: 'meta/llama-3.3-70b-instruct',
  systemPrompt: 'be helpful',
  messages: [{ role: 'user' as const, content: 'hi' }],
  timeoutMs: 5_000,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('stripReasoning', () => {
  it('removes a <think> block', () => {
    expect(stripReasoning('<think>hmm, pricing…</think>Hello!')).toBe('Hello!')
  })

  it('removes multiple blocks and trims', () => {
    expect(stripReasoning('<think>a</think> Hi <think>b</think> ')).toBe('Hi')
  })

  it('returns empty when the model produced only reasoning', () => {
    expect(stripReasoning('<think>endless deliberation</think>')).toBe('')
  })

  it('leaves normal text alone', () => {
    expect(stripReasoning('Plain reply')).toBe('Plain reply')
  })
})

describe('generateNvidia', () => {
  it('calls the NIM endpoint with the OpenAI-compatible shape', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(
      okResponse({
        choices: [{ message: { content: 'Namaste!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    )

    const out = await generateNvidia(ARGS)
    expect(out.text).toBe('Namaste!')
    expect(out.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('meta/llama-3.3-70b-instruct')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    // NIM predates the max_completion_tokens rename.
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'Bearer nvapi-test' })
  })

  it('strips reasoning traces before returning', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        choices: [
          { message: { content: '<think>customer asked price</think>₹499 hai ji.' } },
        ],
      }),
    )
    const out = await generateNvidia(ARGS)
    expect(out.text).toBe('₹499 hai ji.')
  })

  it('treats reasoning-only output as an empty response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        choices: [{ message: { content: '<think>no idea</think>' } }],
      }),
    )
    await expect(generateNvidia(ARGS)).rejects.toMatchObject({
      code: 'empty_response',
    })
  })

  it('throws a typed error on an HTTP failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      errResponse(401, { error: { message: 'Invalid API key' } }),
    )
    await expect(generateNvidia(ARGS)).rejects.toBeInstanceOf(AiError)
  })

  it('maps a network failure to a typed error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(generateNvidia(ARGS)).rejects.toBeInstanceOf(AiError)
  })

  it('returns null usage when the provider omits it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ choices: [{ message: { content: 'ok' } }] }),
    )
    const out = await generateNvidia(ARGS)
    expect(out.usage).toBeNull()
  })
})
