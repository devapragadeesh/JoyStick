/**
 * Compile-time guard on the tool-result field name.
 *
 * This file contains no runtime assertions and no tests — it exists so that
 * `tsc` fails if anyone "corrects" `tool_response` to one of the documented but
 * non-existent names. Each `@ts-expect-error` below is load-bearing in both
 * directions: it fails if the erroneous field becomes valid, and TypeScript
 * separately reports an *unused* `@ts-expect-error` if the field it guards stops
 * being an error. Deleting a line here silently removes a guard.
 *
 * It deliberately lives outside `*.test.ts` so the package build type-checks it.
 */
import type { BatchToolCall } from "./events.js";
import { toolResponseOf } from "./events.js";

declare const call: BatchToolCall;

// The observed field must exist.
const observed: unknown = call.tool_response;
void observed;

// The documented-but-unobserved fallback is retained deliberately.
const documented: unknown = call.output;
void documented;

// @ts-expect-error `tool_result` is PostToolUse's *documented* name and is not
// part of a batch tool call. If this stops erroring, someone has renamed the
// field to the name the docs wrongly specify.
void call.tool_result;

// @ts-expect-error Guards against a plausible typo that would silently read undefined.
void call.toolResponse;

// @ts-expect-error Guards against reintroducing the singular PostToolUse shape here.
void call.result;

// The helper accepts anything and narrows internally, so these must all compile.
void toolResponseOf(call);
void toolResponseOf({ tool_response: "x" });
void toolResponseOf(undefined);
