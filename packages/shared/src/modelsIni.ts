import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type ModelsIniNode =
  | {type: 'blank'; raw: string}
  | {type: 'comment'; raw: string}
  | {type: 'malformed'; raw: string}
  | {type: 'section'; name: string; raw?: string; dirty?: boolean}
  | {type: 'keyValue'; key: string; value: string; raw?: string; dirty?: boolean};

export type ModelsIniDocument = {
  nodes: ModelsIniNode[];
};

export type ModelsIniIssue = {
  code:
    | 'duplicate_key'
    | 'duplicate_section'
    | 'empty_key'
    | 'empty_section'
    | 'invalid_key'
    | 'invalid_section';
  message: string;
  sectionName?: string;
  key?: string;
};

export function parseModelsIni(text: string): ModelsIniDocument {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines =
    normalized.length === 0
      ? []
      : normalized.endsWith('\n')
        ? normalized.slice(0, -1).split('\n')
        : normalized.split('\n');

  return {
    nodes: lines.map(parseModelsIniLine),
  };
}

export function stringifyModelsIni(document: ModelsIniDocument): string {
  if (document.nodes.length === 0) {
    return '';
  }
  return `${document.nodes.map(stringifyModelsIniNode).join('\n')}\n`;
}

export function listModelsIniSections(document: ModelsIniDocument): string[] {
  return document.nodes.flatMap(node => (node.type === 'section' ? [node.name] : []));
}

export function getModelsIniSectionValues(
  document: ModelsIniDocument,
  sectionName: string | null,
): Map<string, string> {
  const bounds = getSectionBounds(document.nodes, sectionName);
  const values = new Map<string, string>();
  if (!bounds) {
    return values;
  }

  for (let index = bounds.start; index < bounds.end; index += 1) {
    const node = document.nodes[index];
    if (node?.type === 'keyValue') {
      values.set(normalizeKey(node.key), node.value);
    }
  }
  return values;
}

export function getModelsIniValue(
  document: ModelsIniDocument,
  sectionName: string | null,
  key: string,
): string | undefined {
  return getModelsIniSectionValues(document, sectionName).get(normalizeKey(key));
}

export function upsertModelsIniValues(
  document: ModelsIniDocument,
  sectionName: string | null,
  values: Readonly<Record<string, string | number | boolean>>,
): ModelsIniDocument {
  const next = cloneModelsIniDocument(document);
  const entries = Object.entries(values).map(([key, value]) => ({
    key: normalizeKey(key),
    value: String(value).replace(/[\r\n]/g, ' '),
  }));

  let bounds = getSectionBounds(next.nodes, sectionName);
  if (!bounds) {
    if (sectionName == null) {
      bounds = {header: -1, start: 0, end: firstSectionIndex(next.nodes)};
    } else {
      appendSection(next.nodes, sectionName);
      bounds = getSectionBounds(next.nodes, sectionName);
    }
  }

  if (!bounds) {
    throw new Error(`Could not create models.ini section ${sectionName ?? '<preamble>'}`);
  }

  for (const entry of entries) {
    const existingIndex = findLastKeyIndex(next.nodes, bounds.start, bounds.end, entry.key);
    if (existingIndex >= 0) {
      next.nodes[existingIndex] = {
        type: 'keyValue',
        key: entry.key,
        value: entry.value,
        dirty: true,
      };
      continue;
    }

    const insertAt = findSectionInsertIndex(next.nodes, bounds.start, bounds.end);
    next.nodes.splice(insertAt, 0, {
      type: 'keyValue',
      key: entry.key,
      value: entry.value,
      dirty: true,
    });
    bounds.end += 1;
  }

  return next;
}

export function removeModelsIniKeys(
  document: ModelsIniDocument,
  sectionName: string | null,
  keys: readonly string[],
): ModelsIniDocument {
  const next = cloneModelsIniDocument(document);
  const keySet = new Set(keys.map(normalizeKey));
  const bounds = getSectionBounds(next.nodes, sectionName);
  if (!bounds) {
    return next;
  }

  next.nodes = next.nodes.filter((node, index) => {
    if (index < bounds.start || index >= bounds.end || node.type !== 'keyValue') {
      return true;
    }
    return !keySet.has(normalizeKey(node.key));
  });
  return next;
}

export function validateModelsIniDocument(document: ModelsIniDocument): ModelsIniIssue[] {
  const issues: ModelsIniIssue[] = [];
  const seenSections = new Set<string>();
  let currentSection: string | null = null;
  let sectionKeys = new Map<string | null, Set<string>>();

  for (const node of document.nodes) {
    if (node.type === 'section') {
      currentSection = node.name;
      const normalizedSection = normalizeSectionName(node.name);
      if (node.name.length === 0) {
        issues.push({
          code: 'empty_section',
          message: 'Section names cannot be empty.',
          sectionName: node.name,
        });
      }
      if (/[[\]\r\n]/.test(node.name)) {
        issues.push({
          code: 'invalid_section',
          message: 'Section names cannot contain brackets or newlines.',
          sectionName: node.name,
        });
      }
      if (seenSections.has(normalizedSection)) {
        issues.push({
          code: 'duplicate_section',
          message: `Duplicate section: ${node.name}`,
          sectionName: node.name,
        });
      }
      seenSections.add(normalizedSection);
      if (!sectionKeys.has(currentSection)) {
        sectionKeys.set(currentSection, new Set());
      }
      continue;
    }

    if (node.type !== 'keyValue') {
      continue;
    }

    const key = normalizeKey(node.key);
    if (key.length === 0) {
      issues.push({
        code: 'empty_key',
        message: 'Keys cannot be empty.',
        sectionName: currentSection ?? undefined,
        key: node.key,
      });
      continue;
    }
    if (/[=\r\n]/.test(node.key)) {
      issues.push({
        code: 'invalid_key',
        message: 'Keys cannot contain equals signs or newlines.',
        sectionName: currentSection ?? undefined,
        key: node.key,
      });
    }

    const keys = sectionKeys.get(currentSection) ?? new Set<string>();
    if (keys.has(key)) {
      issues.push({
        code: 'duplicate_key',
        message: `Duplicate key ${key} in section ${currentSection ?? '<preamble>'}.`,
        sectionName: currentSection ?? undefined,
        key,
      });
    }
    keys.add(key);
    sectionKeys.set(currentSection, keys);
  }

  return issues;
}

export async function writeModelsIniAtomic(
  filePath: string,
  content: ModelsIniDocument | string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const text = typeof content === 'string' ? content : stringifyModelsIni(content);
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;

  try {
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, {force: true}).catch(() => undefined);
  }
}

export function canonicalizeHuggingFaceRef(ref: string): string {
  const parsed = splitHuggingFaceRef(ref);
  if (!parsed) {
    return ref;
  }
  return `${parsed.repoId}:${canonicalizeQuantTag(parsed.quant)}`;
}

export function sectionIdForHuggingFaceRef(
  ref: string,
  existing: Iterable<{sectionId: string; hfRepo?: string | null}> = [],
): string {
  const candidate = canonicalizeHuggingFaceRef(ref);
  for (const item of existing) {
    if (item.sectionId === candidate && item.hfRepo != null && item.hfRepo !== ref) {
      return `${candidate}-${shortHash(ref)}`;
    }
  }
  return candidate;
}

export function canonicalizeQuantTag(input: string): string {
  let tag = input.trim();
  tag = tag.split(/[?#]/, 1)[0] ?? tag;
  tag = tag.split(/[\\/]/).at(-1) ?? tag;
  tag = tag.replace(/\.gguf$/i, '');
  tag = tag.replace(/[-_.]?\d{5}-of-\d{5}$/i, '');

  const quantMatch = tag.match(
    /(?:^|[-_.])(?:UD[-_])?((?:IQ\d_[A-Za-z0-9_]+)|(?:Q\d(?:_[A-Za-z0-9]+)+)|BF16|F16|F32)(?:$|[-_.])/,
  );
  if (quantMatch?.[1]) {
    return quantMatch[1];
  }

  return tag.replace(/^UD[-_]/i, '');
}

function splitHuggingFaceRef(ref: string): {repoId: string; quant: string} | null {
  const separator = ref.lastIndexOf(':');
  if (separator < 0) {
    return null;
  }
  const repoId = ref.slice(0, separator);
  const quant = ref.slice(separator + 1);
  if (!repoId || !quant) {
    return null;
  }
  return {repoId, quant};
}

function parseModelsIniLine(raw: string): ModelsIniNode {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {type: 'blank', raw};
  }
  if (trimmed.startsWith(';') || trimmed.startsWith('#')) {
    return {type: 'comment', raw};
  }

  const section = raw.match(/^\s*\[([^\]\r\n]*)\]\s*(?:[;#].*)?$/);
  if (section) {
    return {type: 'section', name: section[1] ?? '', raw};
  }

  const equalsIndex = raw.indexOf('=');
  if (equalsIndex > -1) {
    const key = raw.slice(0, equalsIndex).trim();
    const value = raw.slice(equalsIndex + 1).trim();
    return {type: 'keyValue', key, value, raw};
  }

  return {type: 'malformed', raw};
}

function stringifyModelsIniNode(node: ModelsIniNode): string {
  if ((!('dirty' in node) || !node.dirty) && node.raw != null) {
    return node.raw;
  }

  switch (node.type) {
    case 'blank':
    case 'comment':
    case 'malformed':
      return node.raw;
    case 'section':
      return `[${node.name}]`;
    case 'keyValue':
      return `${node.key} = ${node.value}`;
  }
}

function cloneModelsIniDocument(document: ModelsIniDocument): ModelsIniDocument {
  return {
    nodes: document.nodes.map(node => ({...node})),
  };
}

function appendSection(nodes: ModelsIniNode[], sectionName: string): void {
  if (nodes.length > 0 && nodes.at(-1)?.type !== 'blank') {
    nodes.push({type: 'blank', raw: ''});
  }
  nodes.push({type: 'section', name: sectionName, dirty: true});
}

function getSectionBounds(
  nodes: ModelsIniNode[],
  sectionName: string | null,
): {header: number; start: number; end: number} | null {
  if (sectionName == null) {
    return {header: -1, start: 0, end: firstSectionIndex(nodes)};
  }

  const normalizedName = normalizeSectionName(sectionName);
  const header = nodes.findIndex(
    node => node.type === 'section' && normalizeSectionName(node.name) === normalizedName,
  );
  if (header < 0) {
    return null;
  }

  let end = nodes.length;
  for (let index = header + 1; index < nodes.length; index += 1) {
    if (nodes[index]?.type === 'section') {
      end = index;
      break;
    }
  }
  return {header, start: header + 1, end};
}

function firstSectionIndex(nodes: ModelsIniNode[]): number {
  const index = nodes.findIndex(node => node.type === 'section');
  return index < 0 ? nodes.length : index;
}

function findLastKeyIndex(nodes: ModelsIniNode[], start: number, end: number, key: string): number {
  for (let index = end - 1; index >= start; index -= 1) {
    const node = nodes[index];
    if (node?.type === 'keyValue' && normalizeKey(node.key) === normalizeKey(key)) {
      return index;
    }
  }
  return -1;
}

function findSectionInsertIndex(nodes: ModelsIniNode[], start: number, end: number): number {
  let index = end;
  while (index > start && nodes[index - 1]?.type === 'blank') {
    index -= 1;
  }
  return index;
}

function normalizeKey(key: string): string {
  return key.trim();
}

function normalizeSectionName(sectionName: string): string {
  return sectionName.trim();
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}
