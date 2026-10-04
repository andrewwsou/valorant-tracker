/**
 * Cost guardrails, checked on every CI run.
 *
 * This project never calls an AI model itself. The MCP server only answers tool
 * calls from the AI client a user chooses to run, so tokens are only ever spent
 * by that client. If one of these checks fails, see "Cost safeguards" in the
 * README before changing it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Every TypeScript and JavaScript source file under `dir`, skipping generated code and tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.ts$/.test(f) && !f.startsWith("generated"))
    .map((f) => join(dir, f));
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("cost guardrails", () => {
  it("depends on no AI model SDK", () => {
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const aiSdk =
      /^(@anthropic-ai\/|openai$|@openai\/|ai$|@ai-sdk\/|langchain$|@langchain\/|@google\/(genai|generative-ai)$|@mistralai\/|cohere-ai$|groq-sdk$|ollama$)/;
    expect(deps.filter((d) => aiSdk.test(d))).toEqual([]);
  });

  it("calls no AI model API directly", () => {
    const hosts = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai/;
    const offenders = [...sourceFiles("src"), ...sourceFiles("scripts")].filter((f) => hosts.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("keeps the MCP server free of sampling, elicitation, and background work", () => {
    // Sampling (createMessage, requestSampling) is how an MCP server could make the client's
    // model generate text. Elicitation and input-required results make the client ask the user,
    // which starts more model turns. setInterval would keep work running between tool calls.
    // server.test.ts also checks at runtime that no tool call ever sends such a request.
    const forbidden = /createMessage|requestSampling|elicitInput|inputRequired|setInterval|setImmediate/;
    const offenders = sourceFiles("src/mcp").filter((f) => forbidden.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
