import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

import { OpenCodeProvider } from "../src/providers/llm/opencode.js"
import { OllamaProvider } from "../src/providers/llm/ollama.js"

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
}

afterEach(() => {
  vi.restoreAllMocks()
  spawnMock.mockReset()
})

describe("OllamaProvider outcomes", () => {
  it("maps done_reason to the shared finish reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ response: '{"ok":', done_reason: "length" }), {
          status: 200,
        }),
      ),
    )
    const provider = new OllamaProvider({ model: "local-test" })

    await expect(provider.generate({ prompt: "Return JSON", format: "json" })).resolves.toEqual({
      text: '{"ok":',
      finishReason: "length",
      providerFinishReason: "length",
    })
  })
})

describe("OpenCodeProvider outcomes", () => {
  it("reads the terminal reason from the JSON event stream", async () => {
    const child = new FakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({ type: "text", part: { type: "text", text: '{"ok":' } })}\n` +
            `${JSON.stringify({ type: "step_finish", part: { reason: "length" } })}\n`,
        )
        child.emit("close", 0)
      })
      return child
    })
    const provider = new OpenCodeProvider()

    await expect(provider.generate({ prompt: "Return JSON", format: "json" })).resolves.toEqual({
      text: '{"ok":',
      finishReason: "length",
      providerFinishReason: "length",
    })
  })

  it("does not treat an intermediate tool-calls step as the end of the run", async () => {
    const child = new FakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.end(
          `${JSON.stringify({ type: "text", part: { type: "text", text: '{"ok":true}' } })}\n` +
            `${JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } })}\n`,
        )
        child.emit("close", 0)
      })
      return child
    })
    const provider = new OpenCodeProvider()

    await expect(provider.generate({ prompt: "Return JSON", format: "json" })).resolves.toEqual({
      text: '{"ok":true}',
      finishReason: undefined,
      providerFinishReason: "tool-calls",
    })
  })
})
