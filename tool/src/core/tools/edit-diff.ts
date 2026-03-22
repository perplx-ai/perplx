import * as Diff from 'diff';
import { constants } from 'fs';
import { access, readFile } from 'fs/promises';
import { resolveToCwd } from './path-utils.js';

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')

    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')

    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")

    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')

    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')

    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

export interface FuzzyMatchResult {
  found: boolean;

  index: number;

  matchLength: number;

  usedFuzzyMatch: boolean;

  contentForReplacement: string;
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent
  };
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content };
}

export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split('\n');
    if (raw[raw.length - 1] === '') {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ');
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

      if (lastWasChange || nextPartIsChange) {
        let linesToShow = raw;
        let skipStart = 0;
        let skipEnd = 0;

        if (!lastWasChange) {
          skipStart = Math.max(0, raw.length - contextLines);
          linesToShow = raw.slice(skipStart);
        }

        if (!nextPartIsChange && linesToShow.length > contextLines) {
          skipEnd = linesToShow.length - contextLines;
          linesToShow = linesToShow.slice(0, contextLines);
        }

        if (skipStart > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);

          oldLineNum += skipStart;
          newLineNum += skipStart;
        }

        for (const line of linesToShow) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }

        if (skipEnd > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);

          oldLineNum += skipEnd;
          newLineNum += skipEnd;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }

      lastWasChange = false;
    }
  }

  return { diff: output.join('\n'), firstChangedLine };
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface EditDiffError {
  error: string;
}

export async function computeEditDiff(path: string, oldText: string, newText: string, cwd: string): Promise<EditDiffResult | EditDiffError> {
  const absolutePath = resolveToCwd(path, cwd);

  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch {
      return { error: `File not found: ${path}` };
    }

    const rawContent = await readFile(absolutePath, 'utf-8');

    const { text: content } = stripBom(rawContent);

    const normalizedContent = normalizeToLF(content);
    const normalizedOldText = normalizeToLF(oldText);
    const normalizedNewText = normalizeToLF(newText);

    const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

    if (!matchResult.found) {
      return {
        error: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
      };
    }

    const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
    const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
    const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

    if (occurrences > 1) {
      return {
        error: `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
      };
    }

    const baseContent = matchResult.contentForReplacement;
    const newContent =
      baseContent.substring(0, matchResult.index) + normalizedNewText + baseContent.substring(matchResult.index + matchResult.matchLength);

    if (baseContent === newContent) {
      return {
        error: `No changes would be made to ${path}. The replacement produces identical content.`
      };
    }

    return generateDiffString(baseContent, newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
