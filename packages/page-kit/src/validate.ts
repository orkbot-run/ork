// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 validation is preserved; top-level hook checks are Ork additions.

/// <reference path="./sucrase-parser.d.ts" />
import { PAGE_SOURCE_MAX_BYTES, pageSourceBytes } from "@orkbot/contracts";
// Sucrase's own parser, pinned with it, so the check reads the same tokens the compiler does.
import { parse } from "sucrase/dist/parser/index.js";
import { IdentifierRole } from "sucrase/dist/parser/tokenizer/index.js";
import { TokenType } from "sucrase/dist/parser/tokenizer/types.js";
import { compilePageSource, declaredSources, pageViewerCode } from "./compile.js";
import {
  PAGE_GLOBALS,
  PAGE_HELPERS,
  PAGE_KIT_COMPONENTS,
  PAGE_KIT_MODULE,
  PAGE_MODULES,
} from "./components.js";
import { selfRenderingKitNames, selfRenderingMessage } from "./shadow.js";

export { PAGE_KIT_GUIDE } from "./guide.js";

const MAX_REPORTED_ERRORS = 20;

/**
 * A page that passes carries its viewer code, compiled once here and stored with the version.
 * Warnings do not stop the save; they tell the bot about text the reader would see verbatim.
 */
type PageSourceCheck =
  | { ok: true; code: string; warnings?: string[] }
  | { ok: false; errors: string[] };

const KIT_NAMES: ReadonlySet<string> = new Set(PAGE_KIT_COMPONENTS);
// Built once; the kit is long enough that the checker gives up on joining the literal tuple.
const KIT_LIST = (PAGE_KIT_COMPONENTS as readonly string[]).join(", ");
// Escapes JSX decodes in its own text, but that a JavaScript string shows as typed.
const HTML_ENTITY = /&(?:lt|gt|amp|quot|apos|nbsp|#39|#x27);/;

const GIVEN: ReadonlySet<string> = new Set(PAGE_GLOBALS);
const DECLARATION_ROLES: ReadonlySet<IdentifierRole | null> = new Set([
  IdentifierRole.TopLevelDeclaration,
  IdentifierRole.FunctionScopedDeclaration,
  IdentifierRole.BlockScopedDeclaration,
  IdentifierRole.ObjectShorthandTopLevelDeclaration,
  IdentifierRole.ObjectShorthandFunctionScopedDeclaration,
  IdentifierRole.ObjectShorthandBlockScopedDeclaration,
  IdentifierRole.ImportDeclaration,
]);

/**
 * Catches mistakes before the user sees the page, with line numbers the bot can act on. It is
 * not a security boundary: page code runs only inside the sandboxed viewer, which is the boundary.
 */
export function checkPageSource(source: string): PageSourceCheck {
  const bytes = pageSourceBytes(source);
  if (bytes > PAGE_SOURCE_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        `The page is ${bytes} bytes; the limit is ${PAGE_SOURCE_MAX_BYTES}. Move data out or split the page.`,
      ],
    };
  }
  const lineOf = lineLocator(source);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source, true, false, false);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const tokens = parsed.tokens;
  const errors: string[] = [];
  for (const token of topLevelHookCalls(parsed, source)) {
    errors.push(
      `line ${lineOf(token.start)}: call hooks inside a component or hook, not at the top level.`,
    );
  }
  const warnings: string[] = [];
  const declared = new Set<string>();
  const tags = new Map<string, number>();
  let defaults = 0;
  const blocked = new Set<string>();
  tokens.forEach((token, index) => {
    const text = source.slice(token.start, token.end);
    const line = lineOf(token.start);
    if (token.type === TokenType._import) {
      const problem = importProblem(tokens, index, source);
      if (problem) errors.push(`line ${line}: ${problem}`);
    } else if (
      (token.type === TokenType.string || token.type === TokenType.template) &&
      !isJsxAttributeValue(tokens, index) &&
      HTML_ENTITY.test(text)
    ) {
      warnings.push(
        `line ${line}: ${text.match(HTML_ENTITY)![0]} in a JavaScript string shows up literally; write the plain character instead.`,
      );
    } else if (token.type === TokenType._export) {
      if (tokens[index + 1]?.type === TokenType._default) defaults += 1;
      else if (
        tokens[index + 1]?.type === TokenType.braceL &&
        exportsOnlyDefault(tokens, index + 1, source)
      )
        defaults += 1;
      else errors.push(`line ${line}: only \`export default\` is allowed.`);
    } else if (token.type === TokenType.jsxTagStart) {
      const nameToken =
        tokens[index + 1]?.type === TokenType.jsxName ? tokens[index + 1] : undefined;
      const name = nameToken ? source.slice(nameToken.start, nameToken.end) : "";
      // A lowercase first letter makes an element, and HTML reads its name in any case.
      const element = /^[a-z]/.test(name) ? name.toLowerCase() : "";
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    } else if (
      token.type === TokenType.jsxName &&
      /^on[a-z]/i.test(text) &&
      tokens[index + 1]?.type === TokenType.eq &&
      tokens[index + 2]?.type === TokenType.string
    ) {
      errors.push(
        `line ${line}: ${text} takes a function, not a string: write ${text}={() => ...}.`,
      );
    } else if (token.type === TokenType.name && DECLARATION_ROLES.has(token.identifierRole)) {
      declared.add(text);
    } else if (
      token.type === TokenType.name &&
      text === "require" &&
      token.identifierRole === IdentifierRole.Access
    ) {
      errors.push(
        `line ${line}: require is not available; everything a page can use is already in scope.`,
      );
    } else if (
      token.type === TokenType.jsxName &&
      token.identifierRole === IdentifierRole.Access &&
      !tags.has(text)
    ) {
      tags.set(text, line);
    } else if (
      // Compiled pages call React.createElement(Name, ...) where JSX would write <Name>.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL &&
      tokens[index + 2]?.type === TokenType.name &&
      tokens[index + 3]?.type !== TokenType.dot
    ) {
      const name = source.slice(tokens[index + 2]!.start, tokens[index + 2]!.end);
      if (/^[A-Z]/.test(name) && !tags.has(name)) tags.set(name, lineOf(tokens[index + 2]!.start));
    } else if (
      // createElement("iframe") makes the same element <iframe> would.
      token.type === TokenType.name &&
      text === "createElement" &&
      tokens[index + 1]?.type === TokenType.parenL &&
      tokens[index + 2]?.type === TokenType.string
    ) {
      const name = source.slice(tokens[index + 2]!.start + 1, tokens[index + 2]!.end - 1);
      const element = name.toLowerCase();
      if (BLOCKED_ELEMENTS.has(element) && !blocked.has(element)) {
        blocked.add(element);
        errors.push(
          `line ${line}: <${name}> is not allowed in a page; ${BLOCKED_ELEMENTS.get(element)}`,
        );
      }
    }
  });
  for (const { name, start } of selfRenderingKitNames(tokens, source)) {
    errors.push(`line ${lineOf(start)}: ${selfRenderingMessage(name)}`);
  }
  for (const [name, line] of tags) {
    if (GIVEN.has(name) || declared.has(name)) continue;
    errors.push(
      `line ${line}: <${name}> is not a kit component. Use ${KIT_LIST}, or define ${name} in this file.`,
    );
  }
  if (defaults !== 1) {
    errors.push("The page needs exactly one `export default` of its top component.");
  }
  // The list goes back to the model, so a file with the same mistake on every line stays cheap.
  if (errors.length > MAX_REPORTED_ERRORS) {
    const more = errors.length - MAX_REPORTED_ERRORS;
    return { ok: false, errors: [...errors.slice(0, MAX_REPORTED_ERRORS), `…and ${more} more.`] };
  }
  if (errors.length) return { ok: false, errors };
  let compiled: string;
  try {
    declaredSources(source);
    compiled = compilePageSource(source);
  } catch (error) {
    return { ok: false, errors: [syntaxErrorText(error)] };
  }
  const code = pageViewerCode(source, compiled);
  return warnings.length
    ? { ok: true, code, warnings: warnings.slice(0, MAX_REPORTED_ERRORS) }
    : { ok: true, code };
}

type ParsedPage = ReturnType<typeof parse>;

/** Function scopes include expression-bodied arrows and parameter defaults, unlike brace depth. */
function topLevelHookCalls(parsed: ParsedPage, source: string): ParsedPage["tokens"] {
  const { tokens, scopes } = parsed;
  // Match grouping parentheses so a callback argument is never mistaken for an IIFE.
  const parenPairs = new Map<number, number>();
  const parenStack: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.type === TokenType.parenL) parenStack.push(index);
    else if (tokens[index]!.type === TokenType.parenR) {
      const open = parenStack.pop();
      if (open !== undefined) {
        parenPairs.set(open, index);
        parenPairs.set(index, open);
      }
    }
  }
  const word = (index: number) => {
    const token = tokens[index];
    return token ? source.slice(token.start, token.end) : "";
  };
  const immediatelyInvoked = new Map<number, Array<[number, number]>>();
  for (const scope of scopes.slice(0, -1)) {
    if (!scope.isFunctionScope) continue;
    const start = scope.startTokenIndex;
    let expressionStart = start;
    let parameters = start;
    let bodyStart: number;
    // A named function has an additional scope starting at its name.
    if (word(start - 1) === "function") expressionStart = start - 1;
    else if (word(start - 2) === "function") expressionStart = start - 2;
    if (word(expressionStart) === "function") {
      // Calling a generator only creates its iterator; its body remains deferred.
      if (tokens[expressionStart + 1]?.type === TokenType.star) continue;
      if (word(expressionStart - 1) === "async") expressionStart -= 1;
      if (tokens[parameters]?.type !== TokenType.parenL) parameters += 1;
      if (tokens[parameters]?.type !== TokenType.parenL) continue;
      const close = parenPairs.get(parameters);
      if (close === undefined || tokens[close + 1]?.type !== TokenType.braceL) continue;
      bodyStart = close + 1;
    } else {
      if (word(parameters) === "async" && tokens[parameters + 1]?.type !== TokenType.arrow)
        parameters += 1;
      else if (word(start - 1) === "async") expressionStart -= 1;
      const close =
        tokens[parameters]?.type === TokenType.parenL ? parenPairs.get(parameters) : parameters;
      if (close === undefined || tokens[close + 1]?.type !== TokenType.arrow) continue;
      // For expression bodies, do not mistake a nested arrow sharing the end for this function.
      bodyStart = tokens[close + 2]?.type === TokenType.braceL ? close + 2 : close + 1;
    }
    let left = expressionStart;
    let right = scope.endTokenIndex;
    while (tokens[right]?.type === TokenType.parenR && parenPairs.get(right) === left - 1) {
      // The parentheses in consume(() => hook()) belong to the call, not to the callback.
      const beforeOpen = tokens[left - 2];
      if (
        beforeOpen?.type === TokenType.name ||
        beforeOpen?.type === TokenType.parenR ||
        beforeOpen?.type === TokenType.bracketR ||
        beforeOpen?.type === TokenType.questionDot
      )
        break;
      left -= 1;
      right += 1;
    }
    if (
      tokens[right]?.type !== TokenType.parenL &&
      !(
        tokens[right]?.type === TokenType.questionDot &&
        tokens[right + 1]?.type === TokenType.parenL
      )
    )
      continue;
    const ranges = immediatelyInvoked.get(scope.endTokenIndex) ?? [];
    ranges.push([start, bodyStart]);
    immediatelyInvoked.set(scope.endTokenIndex, ranges);
  }
  // Named function expressions have multiple overlapping Sucrase scopes, including
  // one for their body. Merge only the header/body ranges of a proven IIFE.
  for (const ranges of immediatelyInvoked.values()) ranges.sort((a, b) => a[0] - b[0]);
  const belongsToIife = (start: number, end: number) => {
    const ranges = immediatelyInvoked.get(end);
    if (!ranges) return false;
    // Nested arrow bodies sharing an end are not included unless their own
    // range was proved immediately invoked.
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle]![0] <= start) low = middle + 1;
      else high = middle;
    }
    return low > 0 && ranges[low - 1]![1] >= start;
  };
  const boundaries = new Int32Array(tokens.length + 1);
  // Sucrase appends the enclosing program scope last; it is not a callable function.
  for (const scope of scopes.slice(0, -1)) {
    if (!scope.isFunctionScope || belongsToIife(scope.startTokenIndex, scope.endTokenIndex))
      continue;
    boundaries[scope.startTokenIndex]! += 1;
    boundaries[scope.endTokenIndex]! -= 1;
  }
  const found: ParsedPage["tokens"] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    depth += boundaries[index]!;
    const token = tokens[index]!;
    if (depth || (token.type !== TokenType.name && token.type !== TokenType.string)) continue;
    const text = source.slice(token.start, token.end);
    const name = token.type === TokenType.string ? text.slice(1, -1) : text;
    const previous = tokens[index - 1];
    const member =
      token.type === TokenType.name &&
      (previous?.type === TokenType.dot || previous?.type === TokenType.questionDot) &&
      source.slice(tokens[index - 2]?.start, tokens[index - 2]?.end) === "React";
    const computed =
      token.type === TokenType.string &&
      previous?.type === TokenType.bracketL &&
      tokens[index + 1]?.type === TokenType.bracketR &&
      source.slice(tokens[index - 2]?.start, tokens[index - 2]?.end) === "React";
    const direct = token.type === TokenType.name && token.identifierRole === IdentifierRole.Access;
    if (
      (!/^use[A-Z]/.test(name) && !(name === "use" && (member || computed))) ||
      (!direct && !member && !computed)
    )
      continue;
    let left = member || computed ? index - 2 : index;
    let right = computed ? index + 1 : index;
    // Parentheses around a function do not defer its invocation: (useState)(0).
    while (
      tokens[left - 1]?.type === TokenType.parenL &&
      tokens[right + 1]?.type === TokenType.parenR
    ) {
      left -= 1;
      right += 1;
    }
    const next = tokens[right + 1];
    if (
      next?.type === TokenType.parenL ||
      (next?.type === TokenType.questionDot && tokens[right + 2]?.type === TokenType.parenL)
    )
      found.push(token);
  }
  return found;
}

type Tokens = ReturnType<typeof parse>["tokens"];

// Plain HTML and SVG elements are fine for custom visuals; these would load or run something
// else, which the viewer's sandbox blocks anyway, so the page would show a hole.
const BLOCKED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["script", "page code runs from the file itself."],
  ["style", "use style={{...}} on the element or the kit's components."],
  ["iframe", "pages cannot embed other pages."],
  ["object", "pages cannot embed other content."],
  ["embed", "pages cannot embed other content."],
  ["foreignobject", "draw with SVG shapes and text instead."],
]);

/** \`export { App as default }\`, as bundlers write it, names the default export and nothing else. */
function exportsOnlyDefault(tokens: Tokens, open: number, source: string): boolean {
  const words: string[] = [];
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === TokenType.braceR) {
      return words.length === 3 && words[1] === "as" && words[2] === "default";
    }
    words.push(source.slice(token.start, token.end));
  }
  return false;
}

/** An import of React or the kit is allowed and changes nothing; anything else cannot load. */
function importProblem(tokens: Tokens, start: number, source: string): string | undefined {
  const text = (index: number) => source.slice(tokens[index]!.start, tokens[index]!.end);
  let index = start + 1;
  const names: string[] = [];
  let hasDefault = false;
  let inBraces = false;
  for (; index < tokens.length && tokens[index]!.type !== TokenType.string; index++) {
    const type = tokens[index]!.type;
    if (type === TokenType.parenL || type === TokenType.dot) break;
    if (type === TokenType.braceL) inBraces = true;
    else if (type === TokenType.braceR) inBraces = false;
    else if (type === TokenType.name && inBraces && text(index - 1) !== "as")
      names.push(text(index));
    else if (type === TokenType.name && !inBraces && !["from", "as"].includes(text(index))) {
      // A namespace import ("* as Kit") is fine; a bare name is a default import.
      if (text(index - 1) !== "as") hasDefault = true;
    }
  }
  const from = tokens[index]?.type === TokenType.string ? text(index).slice(1, -1) : undefined;
  if (from === undefined || !PAGE_MODULES.has(from)) {
    return `only "react" and "${PAGE_KIT_MODULE}" can be imported, and neither is needed: the kit components, React and its hooks are already in scope.`;
  }
  if (from !== PAGE_KIT_MODULE) return undefined;
  if (hasDefault) return `"${PAGE_KIT_MODULE}" has no default export; import components by name.`;
  const unknown = names.filter(
    (name) =>
      name !== "as" &&
      !KIT_NAMES.has(name) &&
      !PAGE_HELPERS.includes(name as (typeof PAGE_HELPERS)[number]),
  );
  return unknown.length
    ? `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not in the kit. Use ${KIT_LIST}.`
    : undefined;
}

function isJsxAttributeValue(tokens: Tokens, index: number): boolean {
  return tokens[index - 1]?.type === TokenType.eq && tokens[index - 2]?.type === TokenType.jsxName;
}

function syntaxErrorText(error: unknown): string {
  const loc = (error as { loc?: { line: number; column: number } }).loc;
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /\s*\(\d+:\d+\)$/,
    "",
  );
  return loc ? `line ${loc.line}, column ${loc.column + 1}: ${message}` : message;
}

function lineLocator(source: string): (offset: number) => number {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
