import {
  App,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  requestUrl,
} from 'obsidian';
import { encode } from 'plantuml-encoder';

const VIEW_TYPE_PUML = 'puml-viewer';
const encodePlantuml = encode;
const CSS_AUTO = 'auto';
const CSS_NONE = 'none';
const SUPPORTED_PLANTUML_EXTENSIONS = ['puml'] as const;
const SUPPORTED_MERMAID_EXTENSIONS = ['mermaid', 'mmd', 'marmaid'] as const;
const SUPPORTED_DIAGRAM_EXTENSIONS = [
  ...SUPPORTED_PLANTUML_EXTENSIONS,
  ...SUPPORTED_MERMAID_EXTENSIONS,
] as const;

type ViewMode = 'view' | 'edit';
type DiagramFormat = 'svg' | 'png' | 'txt';
type DiagramType = 'plantuml' | 'mermaid';
type ExportConflictAction = 'overwrite' | 'new-file' | 'cancel';

interface PUMLViewerSettings {
  serverType: 'plantuml' | 'kroki' | 'local';
  plantumlServerUrl: string;
  krokiServerUrl: string;
  krokiDiagramType: DiagramType;
  localServerUrl: string;
  imageFormat: 'svg' | 'png';
  autoZoom100: boolean;
  linkRules: LinkRule[];
  headerLinkRules: HeaderLinkRule[];
  linkModifiers: LinkModifierSettings;
  invertInDarkMode: boolean;
  autoRefresh: boolean;
  embeddedDefaultView: 'diagram' | 'code';
  embeddedDiagramAlign: 'left' | 'center' | 'right';
}

const DEFAULT_SETTINGS: PUMLViewerSettings = {
  serverType: 'plantuml',
  plantumlServerUrl: 'https://www.plantuml.com/plantuml',
  krokiServerUrl: 'https://kroki.io',
  krokiDiagramType: 'plantuml',
  localServerUrl: 'http://localhost:8000',
  imageFormat: 'svg',
  autoZoom100: true,
  linkRules: [],
  headerLinkRules: [],
  linkModifiers: { tab: 'ctrl', split: 'shift', window: 'alt' },
  invertInDarkMode: true,
  autoRefresh: true,
  embeddedDefaultView: 'diagram',
  embeddedDiagramAlign: 'center',
};

interface PUMLViewState extends Record<string, unknown> {
  file?: string;
  mode?: ViewMode;
}

function getDiagramTypeByExtension(extension: string): DiagramType | null {
  const normalized = extension.toLowerCase();
  if ((SUPPORTED_PLANTUML_EXTENSIONS as readonly string[]).includes(normalized)) return 'plantuml';
  if ((SUPPORTED_MERMAID_EXTENSIONS as readonly string[]).includes(normalized)) return 'mermaid';
  return null;
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripWidthHeightFromInlineStyle(styleValue: string): string {
  const chunks = styleValue
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const kept = chunks.filter((chunk) => {
    const colonIdx = chunk.indexOf(':');
    if (colonIdx <= 0) return true;
    const key = chunk.slice(0, colonIdx).trim().toLowerCase();
    return key !== 'width' && key !== 'height';
  });

  return kept.join('; ');
}

function normalizeSvgForResponsiveLayout(svgEl: SVGSVGElement): void {
  const viewBox = svgEl.getAttribute('viewBox')?.trim() ?? '';
  if (!viewBox) {
    const width = parseSvgLength(svgEl.getAttribute('width'));
    const height = parseSvgLength(svgEl.getAttribute('height'));
    if (width > 0 && height > 0) {
      svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
  }

  // PlantUML often emits preserveAspectRatio="none", which stretches the diagram.
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Fixed root dimensions can force stretching when CSS constrains only width.
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');

  const styleAttr = svgEl.getAttribute('style');
  if (styleAttr) {
    const sanitizedStyle = stripWidthHeightFromInlineStyle(styleAttr);
    if (sanitizedStyle.length > 0) {
      svgEl.setAttribute('style', sanitizedStyle);
    } else {
      svgEl.removeAttribute('style');
    }
  }
}

interface LinkRule {
  search: string;
  replace: string;
  scope: 'line' | 'classMember';
}

/**
 * Applies the configured link rules, in order, to PlantUML source before rendering.
 * The file itself is not changed.
 */
function applyLinkRules(source: string, rules: LinkRule[]): string {
  return rules.reduce((text, rule) => applyLinkRule(text, rule), source);
}

function applyLinkRule(source: string, rule: LinkRule): string {
  if (!rule.search.trim()) return source;
  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.search, 'g');
  } catch {
    new Notice(`Link rule search is not a valid regex: ${rule.search}`);
    return source;
  }

  const classHeader = /^\s*(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)[^{]*\{\s*$/;
  let currentClass: string | null = null;
  return source
    .split('\n')
    .map((line) => {
      if (line.includes('[[')) return line;
      if (rule.scope === 'line') return line.replace(pattern, rule.replace);
      if (currentClass === null) {
        const header = classHeader.exec(line);
        if (header) currentClass = header[1];
        return line;
      }
      if (line.trim() === '}') {
        currentClass = null;
        return line;
      }
      return line.replace(pattern, rule.replace.split('{class}').join(currentClass));
    })
    .join('\n');
}

interface HeaderLinkRule {
  pathMatch: string;
  targetPath: string;
  label: string;
}

type ModifierKey = 'none' | 'ctrl' | 'meta' | 'alt' | 'shift';
type LinkOpenMode = 'same' | 'tab' | 'split' | 'window';
interface LinkModifierSettings {
  tab: ModifierKey;
  split: ModifierKey;
  window: ModifierKey;
}

function fillTemplate(template: string, groups: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_full, key: string) => groups[key] ?? '');
}

/** Path from the folder of fromFile to toFile, both vault paths, e.g. ../ChrgFstCtl_classes.puml. */
function relativeVaultPath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toParts = toFile.split('/');
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) {
    common++;
  }
  const ups = fromDir.length - common;
  return [...Array<string>(ups).fill('..'), ...toParts.slice(common)].join('/');
}

/** Resolves a link path against the folder of sourcePath, normalising . and .. segments. */
function resolveVaultPath(linkpath: string, sourcePath: string): string {
  const parts = sourcePath.split('/').slice(0, -1);
  for (const part of linkpath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/**
 * Adds a header block with one link per matching rule, placed after @startuml.
 * pathMatch is tested against the vault path of the open file. Its named groups fill
 * {name} placeholders in targetPath and label; {name} falls back to the file stem.
 * A rule never links to the file that is open, a target is linked once, and a target is
 * linked only if exists() reports it in the vault.
 * The file itself is not changed.
 */
function applyHeaderLinkRules(
  source: string,
  filePath: string,
  rules: HeaderLinkRule[],
  exists: (path: string) => boolean,
): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const stem = fileName.replace(/\.[^.]+$/, '');
  const links: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.pathMatch.trim() || !rule.targetPath.trim()) continue;
    let match: RegExpExecArray | null;
    try {
      match = new RegExp(rule.pathMatch).exec(filePath);
    } catch {
      new Notice(`Header link path check is not a valid regex: ${rule.pathMatch}`);
      continue;
    }
    if (!match) continue;
    const groups: Record<string, string> = { name: stem };
    for (const [key, value] of Object.entries(match.groups ?? {})) groups[key] = value ?? '';
    const target = fillTemplate(rule.targetPath, groups).trim();
    if (target === filePath || seen.has(target)) continue;
    if (!exists(target)) continue;
    seen.add(target);
    const label = fillTemplate(rule.label, groups).replace(/[[\]]/g, '').trim() || target;
    links.push(`[[${encodeURI(relativeVaultPath(filePath, target))} ${label}]]`);
  }
  if (links.length === 0) return source;
  const lines = source.split('\n');
  const startIdx = lines.findIndex((line) => /^\s*@startuml\b/.test(line));
  if (startIdx < 0) return source;
  const block = ['center header', links.join(' | '), 'endheader'];
  return [...lines.slice(0, startIdx + 1), ...block, ...lines.slice(startIdx + 1)].join('\n');
}

/** Maps a click to the way a vault link opens. Split wins, then window, then tab. */
function linkOpenMode(event: MouseEvent, mods: LinkModifierSettings): LinkOpenMode {
  const pressed = (key: ModifierKey): boolean => {
    switch (key) {
      case 'ctrl':
        return event.ctrlKey;
      case 'meta':
        return event.metaKey;
      case 'alt':
        return event.altKey;
      case 'shift':
        return event.shiftKey;
      default:
        return false;
    }
  };
  if (pressed(mods.split)) return 'split';
  if (pressed(mods.window)) return 'window';
  if (pressed(mods.tab)) return 'tab';
  return 'same';
}

function parseSvgMarkup(svgMarkup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const svgEl = parsed.querySelector('svg');
  if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') return null;

  // In Obsidian/Electron, cross-realm `instanceof SVGSVGElement` checks can fail.
  // Validate by tag name and return the imported node as an SVG root element.
  const imported = window.activeDocument.importNode(svgEl, true) as Element;
  if (imported.tagName.toLowerCase() !== 'svg') return null;
  const normalized = imported as SVGSVGElement;
  normalizeSvgForResponsiveLayout(normalized);
  return normalized;
}

/** Rendered diagram elements: viewer, embedded blocks and the zoom overlay. */
const DIAGRAM_SELECTOR =
  '.puml-viewer-render-root svg, .puml-viewer-render-root img, .puml-embed-diagram svg, .puml-embed-diagram img, .puml-zoom-svg, .puml-zoom-image';

/** Softened inversion: white becomes about #262626 and black text about #D9D9D9; hue is kept. */
const DARK_FILTER = 'invert(0.85) hue-rotate(180deg)';

/** Rules file name inside the plugin folder. */
const RULES_FILE = 'puml-viewer-rules.json';

export default class PUMLViewerPlugin extends Plugin {
  settings!: PUMLViewerSettings;

  async onload(): Promise<void> {
    await this.loadSettings();
    // Migrates existing rules out of data.json into the rules file on first load.
    await this.saveSettings();
    this.watchDiagramInsertions();
    this.applyDiagramInversion();
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyDiagramInversion()));

    this.registerView(VIEW_TYPE_PUML, (leaf) => new PUMLViewerView(leaf, this));
    this.registerExtensions([...SUPPORTED_DIAGRAM_EXTENSIONS], VIEW_TYPE_PUML);

    this.addCommand({
      id: 'open-current-puml-in-viewer',
      name: 'Open current diagram file in viewer',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const canOpen = !!file && getDiagramTypeByExtension(file.extension) !== null;

        if (canOpen && !checking && file) {
          void this.activatePUMLView(file);
        }

        return canOpen;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile || getDiagramTypeByExtension(activeFile.extension) === null) return;

      const activeLeaf = this.app.workspace.getMostRecentLeaf();
      if (activeLeaf?.view.getViewType() === VIEW_TYPE_PUML) return;

      void this.activatePUMLView(activeFile);
    });

    for (const lang of ['plantuml', 'mermaid'] as const) {
      this.registerMarkdownCodeBlockProcessor(lang, async (source, el, ctx) => {
        const fenceWidthHintPx = this.extractFenceWidthHint(
          ctx.getSectionInfo(el)?.text ?? '',
          source,
          lang,
        );
        await this.renderEmbeddedDiagramBlock(source, el, fenceWidthHintPx, lang, ctx.sourcePath);
      });
    }

    this.addSettingTab(new PUMLViewerSettingTab(this.app, this));
  }

  onunload(): void {
    this.diagramObserver?.disconnect();
    this.diagramObserver = null;
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PUML).forEach((leaf) => leaf.detach());
  }

  /** True when Obsidian uses its dark theme. App.isDarkMode exists from 1.10.0; older versions use the body class. */
  isDarkMode(): boolean {
    const app = this.app as App & { isDarkMode?: () => boolean };
    if (typeof app.isDarkMode === 'function') return app.isDarkMode();
    return window.activeDocument.body.classList.contains('theme-dark');
  }

  private diagramObserver: MutationObserver | null = null;

  /** Sets or clears the dark filter on one diagram element, from the setting and the theme. */
  private invertDiagramElement(el: Element): void {
    const invert = this.settings.invertInDarkMode && this.isDarkMode();
    (el as HTMLElement | SVGElement).style.filter = invert ? DARK_FILTER : '';
  }

  /** Re-applies the dark filter to every diagram element on the page. */
  applyDiagramInversion(): void {
    window.activeDocument.querySelectorAll(DIAGRAM_SELECTOR).forEach((el) => this.invertDiagramElement(el));
  }

  /** Applies the filter to diagram elements as they are inserted, so every render path is covered. */
  private watchDiagramInsertions(): void {
    this.diagramObserver = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;
          if (el.matches(DIAGRAM_SELECTOR)) this.invertDiagramElement(el);
          el.querySelectorAll(DIAGRAM_SELECTOR).forEach((child) => this.invertDiagramElement(child));
        });
      }
    });
    this.diagramObserver.observe(window.activeDocument.body, { childList: true, subtree: true });
  }

  /** Opens a link from a diagram click, honouring the modifier keys. Website links open in the browser. */
  openDiagramVaultLink(
    rawHref: string,
    event: MouseEvent,
    sourcePath: string,
    sourceLeaf: WorkspaceLeaf | null,
  ): void {
    const href = rawHref.trim();
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    let linkpath = href;
    try {
      linkpath = decodeURIComponent(href);
    } catch {
      linkpath = href;
    }
    linkpath = linkpath.replace(/^\.\//, '').split('#')[0];
    const target =
      this.app.metadataCache.getFirstLinkpathDest(resolveVaultPath(linkpath, sourcePath), '') ??
      this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    if (!target) {
      new Notice(`Linked file not found: ${linkpath}`);
      return;
    }
    const mode = linkOpenMode(event, this.settings.linkModifiers);
    const leaf =
      mode === 'same'
        ? (sourceLeaf ?? this.app.workspace.getLeaf(false))
        : this.app.workspace.getLeaf(mode);
    void leaf.openFile(target);
  }

  /** Routes every link inside a rendered SVG through openDiagramVaultLink. */
  /** The open markdown leaf for a note, used so a plain click replaces that note's own tab. */
  findMarkdownLeaf(sourcePath: string): WorkspaceLeaf | null {
    return (
      this.app.workspace
        .getLeavesOfType('markdown')
        .find((candidate) => (candidate.view as unknown as { file?: { path?: string } }).file?.path === sourcePath) ??
      null
    );
  }

  bindDiagramLinks(svgEl: Element, sourcePath: string, sourceLeaf: WorkspaceLeaf | null): void {
    svgEl.addEventListener('click', (event: Event) => {
      const mouseEvent = event as MouseEvent;
      if (mouseEvent.button !== 0) return;
      const link = (mouseEvent.target as Element | null)?.closest?.('a') ?? null;
      if (!link) return;
      const href = link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href) return;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      this.openDiagramVaultLink(href, mouseEvent, sourcePath, sourceLeaf);
    });
  }

  async loadSettings(): Promise<void> {
    const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as PUMLViewerSettings & {
      serverUrl?: string;
    };
    if (loaded.linkRules === DEFAULT_SETTINGS.linkRules) {
      loaded.linkRules = [];
      const legacy = loaded as unknown as Record<string, unknown>;
      const methodTemplate = typeof legacy.methodLinkTemplate === 'string' ? legacy.methodLinkTemplate.trim() : '';
      if (methodTemplate) {
        loaded.linkRules.push({
          search: '^(\\s*[+\\-#~]?\\s*)(\\w+)\\s*(\\([^)]*\\))',
          replace: `$1[[${methodTemplate.split('{method}').join('$2')} $2$3]]`,
          scope: 'classMember',
        });
      }
      const callSearch = typeof legacy.callLinkSearch === 'string' ? legacy.callLinkSearch.trim() : '';
      if (callSearch) {
        loaded.linkRules.push({
          search: callSearch,
          replace: typeof legacy.callLinkReplace === 'string' ? legacy.callLinkReplace : '',
          scope: 'line',
        });
      }
    }
    const rulesFile = await this.readRulesFile();
    if (rulesFile) {
      loaded.linkRules = rulesFile.linkRules;
      loaded.headerLinkRules = rulesFile.headerLinkRules;
    }
    loaded.headerLinkRules = Array.isArray(loaded.headerLinkRules)
      ? loaded.headerLinkRules.map((rule) => ({ ...rule }))
      : [];
    loaded.linkModifiers = { ...DEFAULT_SETTINGS.linkModifiers, ...(loaded.linkModifiers ?? {}) };
    const legacyKeys = loaded as unknown as Record<string, unknown>;
    delete legacyKeys.methodLinkTemplate;
    delete legacyKeys.callLinkSearch;
    delete legacyKeys.callLinkReplace;
    if (loaded.serverUrl) {
      if (loaded.serverType === 'kroki') {
        loaded.krokiServerUrl = loaded.serverUrl;
      } else if (loaded.serverType === 'local') {
        loaded.localServerUrl = loaded.serverUrl;
      } else {
        loaded.plantumlServerUrl = loaded.serverUrl;
      }
    }
    this.settings = loaded;
  }

  async saveSettings(): Promise<void> {
    const stored: Partial<PUMLViewerSettings> = { ...this.settings };
    delete stored.linkRules;
    delete stored.headerLinkRules;
    await this.saveData(stored);
    await this.writeRulesFile();
  }

  /** The rules file sits in the plugin folder, next to main.js. Commit it; data.json stays local. */
  private rulesPath(): string {
    return normalizePath(`${this.manifest.dir ?? '.obsidian/plugins/puml-viewer'}/${RULES_FILE}`);
  }

  private async readRulesFile(): Promise<{ linkRules: LinkRule[]; headerLinkRules: HeaderLinkRule[] } | null> {
    const adapter = this.app.vault.adapter;
    const path = this.rulesPath();
    if (!(await adapter.exists(path))) return null;
    try {
      const parsed = JSON.parse(await adapter.read(path)) as Partial<{
        linkRules: LinkRule[];
        headerLinkRules: HeaderLinkRule[];
      }>;
      return {
        linkRules: Array.isArray(parsed.linkRules) ? parsed.linkRules : [],
        headerLinkRules: Array.isArray(parsed.headerLinkRules) ? parsed.headerLinkRules : [],
      };
    } catch {
      new Notice(`Could not read ${path}. Rules were not loaded.`);
      return null;
    }
  }

  private async writeRulesFile(): Promise<void> {
    const text = JSON.stringify(
      { linkRules: this.settings.linkRules, headerLinkRules: this.settings.headerLinkRules },
      null,
      2,
    );
    await this.app.vault.adapter.write(this.rulesPath(), `${text}\n`);
  }

  rerenderMarkdownPreviews(): void {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.previewMode.rerender(true);
      }
    }
  }

  async activatePUMLView(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_PUML,
      active: true,
      state: { file: file.path },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  buildRenderUrl(source: string, diagramType?: DiagramType): string {
    const useKroki = this.settings.serverType === 'kroki' || diagramType === 'mermaid';
    const normalizedBase = useKroki
      ? this.settings.krokiServerUrl.replace(/\/+$/, '').replace(/\/plantuml$/i, '')
      : this.getActiveServerUrl().replace(/\/+$/, '');
    const encoded = encodePlantuml(source);
    const format = this.settings.imageFormat;

    if (useKroki) {
      const resolvedDiagramType = diagramType ?? this.settings.krokiDiagramType;
      return `${normalizedBase}/${resolvedDiagramType}/${format}/${encoded}`;
    }

    return `${normalizedBase}/${format}/${encoded}`;
  }

  private normalizedServerBase(): string {
    let base = this.getActiveServerUrl().replace(/\/+$/, '');
    if (this.settings.serverType === 'kroki') {
      base = base.replace(/\/plantuml$/i, '');
    }
    return base;
  }

  private getActiveServerUrl(): string {
    if (this.settings.serverType === 'kroki') {
      return this.settings.krokiServerUrl;
    }
    if (this.settings.serverType === 'local') {
      return this.settings.localServerUrl;
    }
    return this.settings.plantumlServerUrl;
  }

  responseContentType(response: { headers?: Record<string, string> }): string {
    const headers = response.headers ?? {};
    return headers['content-type'] ?? headers['Content-Type'] ?? '';
  }

  async requestDiagram(source: string, format: DiagramFormat, diagramType?: DiagramType) {
    const useKroki = this.settings.serverType === 'kroki' || diagramType === 'mermaid';
    if (useKroki) {
      const normalizedBase = this.settings.krokiServerUrl
        .replace(/\/+$/, '')
        .replace(/\/plantuml$/i, '');
      const resolvedDiagramType = diagramType ?? this.settings.krokiDiagramType;
      const accept =
        format === 'svg' ? 'image/svg+xml' : format === 'png' ? 'image/png' : 'text/plain';
      return requestUrl({
        url: `${normalizedBase}/${resolvedDiagramType}/${format}`,
        method: 'POST',
        body: source,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: accept,
        },
        throw: false,
      });
    }

    const normalizedBase = this.normalizedServerBase();
    const encoded = encodePlantuml(source);
    return requestUrl({
      url: `${normalizedBase}/${format}/${encoded}`,
      method: 'GET',
      throw: false,
    });
  }

  async fetchPngObjectUrl(source: string, diagramType?: DiagramType): Promise<string> {
    const response = await this.requestDiagram(source, 'png', diagramType);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = this.responseContentType(response);
    if (contentType && !contentType.includes('image/png')) {
      throw new Error(
        `Expected PNG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
      );
    }
    if (!response.arrayBuffer) {
      throw new Error('No PNG payload returned by render server');
    }

    const blob = new Blob([response.arrayBuffer], { type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  async downloadDiagramAs(
    source: string,
    format: 'svg' | 'png',
    baseName = 'diagram',
    diagramType?: DiagramType,
  ): Promise<void> {
    const response = await this.requestDiagram(source, format, diagramType);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    let blob: Blob;
    if (format === 'svg') {
      const contentType = this.responseContentType(response);
      if (contentType && !contentType.includes('image/svg')) {
        throw new Error(
          `Expected SVG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
        );
      }
      if (!response.text.includes('<svg')) {
        throw new Error('Response is not SVG content.');
      }
      blob = new Blob([response.text], { type: 'image/svg+xml' });
    } else {
      const contentType = this.responseContentType(response);
      if (contentType && !contentType.includes('image/png')) {
        throw new Error(
          `Expected PNG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
        );
      }
      if (!response.arrayBuffer) {
        throw new Error('No PNG payload returned by render server');
      }
      blob = new Blob([response.arrayBuffer], { type: 'image/png' });
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = window.activeDocument.body.createEl('a');
    link.href = objectUrl;
    link.download = `${baseName}.${format}`;
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async downloadDiagram(
    source: string,
    baseName = 'diagram',
    diagramType?: DiagramType,
  ): Promise<void> {
    await this.downloadDiagramAs(source, this.settings.imageFormat, baseName, diagramType);
  }

  private async renderEmbeddedDiagramBlock(
    source: string,
    el: HTMLElement,
    fenceWidthHintPx: number | null,
    diagramType: DiagramType,
    sourcePath: string,
  ): Promise<void> {
    const diagramLabel = diagramType === 'mermaid' ? 'Mermaid' : 'PlantUML';
    const { renderSource, widthHintPx } = this.extractEmbeddedWidthHint(source, fenceWidthHintPx);

    const container = el.createDiv({ cls: 'puml-embed-block' });
    const actionsEl = container.createDiv({ cls: 'puml-embed-actions' });
    const toggleBtn = actionsEl.createEl('button', { cls: 'puml-embed-toggle' });
    const zoomBtn = actionsEl.createEl('button', { cls: 'puml-embed-zoom-btn', text: 'Zoom' });
    const saveBtn = actionsEl.createEl('button', { cls: 'puml-embed-save-btn', text: 'Save' });
    const copyBtn = actionsEl.createEl('button', { cls: 'puml-embed-copy-btn', text: 'Copy' });
    toggleBtn.setAttr('aria-label', 'Toggle code and diagram');
    zoomBtn.setAttr('aria-label', 'Open zoom overlay');
    saveBtn.setAttr('aria-label', 'Save image');
    copyBtn.setAttr('aria-label', 'Copy code');
    const diagramPane = container.createDiv({ cls: 'puml-embed-diagram' });
    if (widthHintPx) {
      diagramPane.addClass('puml-embed-diagram--constrained');
      diagramPane.style.setProperty('--puml-embed-max-width', `${widthHintPx}px`);
      diagramPane.addClass(`puml-embed-diagram--align-${this.settings.embeddedDiagramAlign}`);
    }
    const codePane = container.createEl('pre', { cls: 'puml-embed-code' });
    const codeEl = codePane.createEl('code', { cls: 'puml-embed-code-content' });
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const lineEl = codeEl.createSpan({ cls: 'puml-embed-code-line' });
      if (diagramType === 'plantuml') {
        this.renderPlantUmlHighlightedLine(lineEl, line);
      } else {
        lineEl.setText(line);
      }
      if (index < lines.length - 1) {
        lineEl.appendText('\n');
      }
    });
    codePane.hide();

    let showCode = this.settings.embeddedDefaultView === 'code';
    const applyToggleState = () => {
      if (showCode) {
        diagramPane.hide();
        codePane.show();
        toggleBtn.setText('Diagram');
        toggleBtn.setAttr('aria-label', 'Show diagram');
        zoomBtn.addClass('is-hidden');
        saveBtn.addClass('is-hidden');
        copyBtn.removeClass('is-hidden');
      } else {
        codePane.hide();
        diagramPane.show();
        toggleBtn.setText('Code');
        toggleBtn.setAttr('aria-label', 'Show code');
        zoomBtn.removeClass('is-hidden');
        saveBtn.removeClass('is-hidden');
        copyBtn.addClass('is-hidden');
      }
    };

    toggleBtn.addEventListener('click', () => {
      showCode = !showCode;
      applyToggleState();
    });
    applyToggleState();

    if (!renderSource.trim()) {
      diagramPane.createDiv({ cls: 'puml-embed-error', text: `${diagramLabel} block is empty.` });
      return;
    }

    const openZoomOverlay = async () => {
      const overlayEl = window.activeDocument.body.createDiv({ cls: 'puml-zoom-overlay' });

      const panelEl = overlayEl.createDiv({ cls: 'puml-zoom-panel' });

      const headerEl = panelEl.createDiv({ cls: 'puml-zoom-header' });

      headerEl.createDiv();

      const controlsEl = headerEl.createDiv({ cls: 'puml-zoom-controls' });

      const zoomOutBtn = controlsEl.createEl('button', { text: '-' });

      const zoomResetBtn = controlsEl.createEl('button', { text: '100%' });

      const zoomInBtn = controlsEl.createEl('button', { text: '+' });

      const closeBtn = headerEl.createEl('button', { cls: 'puml-zoom-close', text: 'Close' });

      const contentEl = panelEl.createDiv({ cls: 'puml-zoom-content' });

      const canvasEl = contentEl.createDiv({ cls: 'puml-zoom-canvas' });

      const loadingEl = canvasEl.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });

      let zoom = 1;
      let renderedEl: HTMLElement | SVGSVGElement | null = null;
      let baseWidth = 0;
      let centeredInitially = false;
      let isPanning = false;
      let panStartX = 0;
      let panStartY = 0;
      let panScrollLeft = 0;
      let panScrollTop = 0;
      const clampZoom = (value: number) => Math.min(8, Math.max(0.1, Math.round(value * 100) / 100));
      const applyZoom = () => {
        if (!renderedEl || baseWidth <= 0) return;
        renderedEl.style.maxWidth = CSS_NONE;
        renderedEl.style.width = `${Math.max(1, Math.round(baseWidth * zoom))}px`;
        renderedEl.style.height = CSS_AUTO;
      };
      const setZoom = (value: number) => {
        zoom = clampZoom(value);
        zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
        applyZoom();
      };
      const fitToViewport = () => {
        if (!renderedEl || baseWidth <= 0) return;
        const available = Math.max(1, contentEl.clientWidth - 12);
        setZoom(Math.min(1, available / baseWidth));
      };
      const centerViewport = () => {
        if (!renderedEl) return;
        contentEl.scrollLeft = Math.max(0, (contentEl.scrollWidth - contentEl.clientWidth) / 2);
        contentEl.scrollTop = 0;
      };
      const centerViewportOnce = () => {
        if (centeredInitially) return;
        centeredInitially = true;
        window.activeWindow.requestAnimationFrame(() => {
          centerViewport();
        });
      };

      zoomOutBtn.addEventListener('click', () => {
        setZoom(zoom - 0.1);
      });
      zoomResetBtn.addEventListener('click', () => {
        setZoom(1);
      });
      zoomInBtn.addEventListener('click', () => {
        setZoom(zoom + 0.1);
      });

      const onPanMouseMove = (event: MouseEvent) => {
        if (!isPanning) return;
        const dx = event.clientX - panStartX;
        const dy = event.clientY - panStartY;
        contentEl.scrollLeft = panScrollLeft - dx;
        contentEl.scrollTop = panScrollTop - dy;
      };

      const stopPan = () => {
        if (!isPanning) return;
        isPanning = false;
        contentEl.classList.remove('is-panning');
      };

      const onPanMouseUp = () => {
        stopPan();
      };

      contentEl.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.button !== 0) return;
        if (!renderedEl) return;
        isPanning = true;
        panStartX = event.clientX;
        panStartY = event.clientY;
        panScrollLeft = contentEl.scrollLeft;
        panScrollTop = contentEl.scrollTop;
        contentEl.classList.add('is-panning');
        event.preventDefault();
      });
      contentEl.addEventListener('mouseleave', onPanMouseUp);
      window.addEventListener('mousemove', onPanMouseMove);
      window.addEventListener('mouseup', onPanMouseUp);

      const closeOverlay = () => {
        window.activeDocument.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', fitToViewport);
        window.removeEventListener('mousemove', onPanMouseMove);
        window.removeEventListener('mouseup', onPanMouseUp);
        overlayEl.remove();
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeOverlay();
        }
      };

      overlayEl.addEventListener('click', (event) => {
        if (event.target === overlayEl) {
          closeOverlay();
        }
      });
      closeBtn.addEventListener('click', closeOverlay);
      window.activeDocument.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', fitToViewport);

      try {
        if (this.settings.imageFormat === 'svg') {
          const response = await this.requestDiagram(renderSource, 'svg', diagramType);

          if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
          }
          const contentType = this.responseContentType(response);
          if (contentType && !contentType.includes('image/svg')) {
            throw new Error(
              `Expected SVG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
            );
          }
          if (!response.text.includes('<svg')) {
            throw new Error('Response is not SVG content.');
          }

          loadingEl.remove();
          const svgHost = canvasEl.createDiv();
          const svgEl = parseSvgMarkup(response.text);
          if (svgEl) {
            svgEl.addClass('puml-zoom-svg');
            this.bindDiagramLinks(svgEl, sourcePath, this.findMarkdownLeaf(sourcePath));
            let baseSvgWidth = 0;
            try {
              const bbox = svgEl.getBBox();
              if (bbox.width > 0 && bbox.height > 0) {
                svgEl.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
                baseSvgWidth = bbox.width;
              }
            } catch (error) {
              console.debug('Failed to crop SVG by bbox', error);
            }

            renderedEl = svgEl;
            const viewBoxWidth = baseSvgWidth || (svgEl.viewBox?.baseVal?.width ?? 0);
            const widthAttr = Number.parseFloat(svgEl.getAttribute('width') ?? '0');
            const measuredWidth = svgEl.getBoundingClientRect().width;
            baseWidth = viewBoxWidth || widthAttr || measuredWidth || 1000;
            fitToViewport();
            centerViewportOnce();
            svgHost.appendChild(svgEl);
          } else {
            throw new Error('Response is not valid SVG content.');
          }
          canvasEl.appendChild(svgHost);
        } else {
          const img = canvasEl.createEl('img', { cls: 'puml-zoom-image puml-is-hidden' });
          img.alt = `${diagramLabel} diagram`;
          const objectUrl = await this.fetchPngObjectUrl(renderSource, diagramType);
          img.src = objectUrl;

          img.addEventListener(
            'load',
            () => {
              loadingEl.remove();
              renderedEl = img;
              baseWidth = img.naturalWidth || img.getBoundingClientRect().width || 1000;
              fitToViewport();
              img.removeClass('puml-is-hidden');
              centerViewportOnce();
              URL.revokeObjectURL(objectUrl);
            },
            { once: true },
          );
          img.addEventListener(
            'error',
            () => {
              loadingEl.remove();
              URL.revokeObjectURL(objectUrl);
              canvasEl.createDiv({ cls: 'puml-embed-error', text: 'Failed to load PNG diagram.' });
            },
            { once: true },
          );
        }
      } catch (error) {
        loadingEl.remove();
        canvasEl.createDiv({
          cls: 'puml-embed-error',
          text: `Failed to render diagram: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    zoomBtn.addEventListener('click', () => {
      void openZoomOverlay();
    });
    saveBtn.addEventListener('click', (event: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle('Save as PNG').onClick(async () => {
          try {
            await this.downloadDiagramAs(renderSource, 'png', `${diagramType}-diagram`, diagramType);
            new Notice('Diagram saved as PNG');
          } catch (error) {
            new Notice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      menu.addItem((item) =>
        item.setTitle('Save as SVG').onClick(async () => {
          try {
            await this.downloadDiagramAs(renderSource, 'svg', `${diagramType}-diagram`, diagramType);
            new Notice('Diagram saved as SVG');
          } catch (error) {
            new Notice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      menu.showAtMouseEvent(event);
    });
    copyBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(renderSource);
          new Notice(`${diagramLabel} code copied.`);
        } catch (error) {
          new Notice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    });

    const loadingEl = diagramPane.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });
    try {
      if (this.settings.imageFormat === 'svg') {
        const response = await this.requestDiagram(renderSource, 'svg', diagramType);

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        const contentType = this.responseContentType(response);
        if (contentType && !contentType.includes('image/svg')) {
          throw new Error(
            `Expected SVG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
          );
        }
        if (!response.text.includes('<svg')) {
          throw new Error('Response is not SVG content.');
        }

        loadingEl.remove();
        const svgHost = diagramPane.createDiv();
        const svgEl = parseSvgMarkup(response.text);
        if (svgEl) {
          svgEl.addClass('puml-embed-svg');
          this.bindDiagramLinks(svgEl, sourcePath, this.findMarkdownLeaf(sourcePath));
          svgHost.appendChild(svgEl);
        } else {
          throw new Error('Response is not valid SVG content.');
        }
      } else {
        const img = diagramPane.createEl('img', { cls: 'puml-embed-image puml-is-hidden' });
        const objectUrl = await this.fetchPngObjectUrl(renderSource, diagramType);
        img.src = objectUrl;
        img.alt = `${diagramLabel} diagram`;
        img.addEventListener(
          'load',
          () => {
            loadingEl.remove();
            img.removeClass('puml-is-hidden');
            URL.revokeObjectURL(objectUrl);
          },
          { once: true },
        );
        img.addEventListener(
          'error',
          () => {
            loadingEl.remove();
            URL.revokeObjectURL(objectUrl);
            diagramPane.createDiv({ cls: 'puml-embed-error', text: 'Failed to load PNG diagram.' });
          },
          { once: true },
        );
      }
    } catch (error) {
      diagramPane.empty();
      diagramPane.createDiv({
        cls: 'puml-embed-error',
        text: `Failed to render diagram: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private extractEmbeddedWidthHint(
    source: string,
    fenceWidthHintPx: number | null,
  ): { renderSource: string; widthHintPx: number | null } {
    if (fenceWidthHintPx) {
      return { renderSource: source, widthHintPx: fenceWidthHintPx };
    }

    const lines = source.split('\n');
    const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmpty === -1) {
      return { renderSource: source, widthHintPx: null };
    }

    const match = lines[firstNonEmpty].trim().match(/^\|(\d{2,4})$/);
    if (!match) {
      return { renderSource: source, widthHintPx: null };
    }

    const widthHintPx = Math.min(6000, Math.max(120, Number(match[1])));
    lines.splice(firstNonEmpty, 1);
    return { renderSource: lines.join('\n'), widthHintPx };
  }

  private extractFenceWidthHint(sectionText: string, source: string, language: DiagramType): number | null {
    const escapedLanguage = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      '`{3,}\\s*' + escapedLanguage + '(?:\\s+\\|(\\d{2,4}))?\\s*\\n([\\s\\S]*?)`{3,}',
      'gi',
    );
    let match: RegExpExecArray | null = regex.exec(sectionText);
    while (match) {
      const widthRaw = match[1];
      const blockSource = match[2] ?? '';
      if (blockSource.trim() === source.trim() && widthRaw) {
        return Math.min(6000, Math.max(120, Number(widthRaw)));
      }
      match = regex.exec(sectionText);
    }
    return null;
  }

  private renderPlantUmlHighlightedLine(target: HTMLElement, line: string): void {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'") || trimmed.startsWith('//')) {
      target.createSpan({ cls: 'puml-code-comment', text: line });
      return;
    }

    const tokenRegex =
      /(![A-Za-z_]\w*|@[A-Za-z_]\w*|\b(?:actor|participant|boundary|control|entity|database|collections|queue|title|autonumber|skinparam|hide|show|note|left|right|of|as|alt|else|opt|loop|par|break|critical|group|end|if|then|start|stop|emit|endwhile|while|is|endif)\b|"[^"]*"|'[^']*')/gi;

    let lastIndex = 0;
    let match: RegExpExecArray | null = tokenRegex.exec(line);
    while (match) {
      const start = match.index;
      const token = match[0];

      if (start > lastIndex) {
        target.appendText(line.slice(lastIndex, start));
      }

      let cls = 'puml-code-keyword';
      if (token.startsWith('!') || token.startsWith('@')) {
        cls = 'puml-code-directive';
      } else if (token.startsWith('"') || token.startsWith("'")) {
        cls = 'puml-code-string';
      }

      target.createSpan({ cls, text: token });
      lastIndex = start + token.length;
      match = tokenRegex.exec(line);
    }

    if (lastIndex < line.length) {
      target.appendText(line.slice(lastIndex));
    }
  }
}

class PUMLViewerView extends ItemView {
  plugin: PUMLViewerPlugin;
  currentFile: TFile | null = null;

  // Obsidian shows the tab's back and forward arrows only for navigable views (View.navigation).
  navigation = true;
  private mode: ViewMode = 'view';
  private zoom = 1;
  private renderedFilePath: string | null = null;
  private needsCenter = false;
  private statusEl!: HTMLDivElement;
  private zoomValueEl!: HTMLDivElement;
  private imageWrapEl!: HTMLDivElement;
  private contentHostEl!: HTMLDivElement;
  private viewModeBtn!: HTMLButtonElement;
  private editModeBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private zoomOutBtn!: HTMLButtonElement;
  private zoomResetBtn!: HTMLButtonElement;
  private zoomInBtn!: HTMLButtonElement;
  private exportPngBtn!: HTMLButtonElement;
  private exportSvgBtn!: HTMLButtonElement;
  private exportAsciiBtn!: HTMLButtonElement;
  private editorGutterEl: HTMLDivElement | null = null;
  private editorEl: HTMLTextAreaElement | null = null;
  private editorDraft: string | null = null;
  private draftFilePath: string | null = null;
  private isDirty = false;
  private isMainPanning = false;
  private mainPanStartX = 0;
  private mainPanStartY = 0;
  private mainPanScrollLeft = 0;
  private mainPanScrollTop = 0;

  constructor(leaf: WorkspaceLeaf, plugin: PUMLViewerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PUML;
  }

  getDisplayText(): string {
    return this.currentFile ? `Diagram: ${this.currentFile.name}` : 'Diagram Viewer';
  }

  getIcon(): string {
    return 'git-branch-plus';
  }

  private getCurrentDiagramType(): DiagramType | null {
    if (!this.currentFile) return null;
    return getDiagramTypeByExtension(this.currentFile.extension);
  }

  async onOpen(): Promise<void> {
    const viewContainer = this.containerEl.children[1] as HTMLElement;
    viewContainer.empty();
    viewContainer.addClass('puml-viewer-container');

    const toolbar = viewContainer.createDiv({ cls: 'puml-viewer-toolbar' });

    this.viewModeBtn = toolbar.createEl('button', { text: 'View' });
    this.viewModeBtn.addEventListener('click', () => {
      void this.switchMode('view');
    });

    this.editModeBtn = toolbar.createEl('button', { text: 'Edit' });
    this.editModeBtn.addEventListener('click', () => {
      void this.switchMode('edit');
    });

    this.saveBtn = toolbar.createEl('button', { text: 'Save' });
    this.saveBtn.addEventListener('click', () => {
      void this.saveEditor();
    });

    this.zoomOutBtn = toolbar.createEl('button', { text: '-' });
    this.zoomOutBtn.addEventListener('click', () => {
      this.setZoom(this.zoom - 0.1);
    });

    this.zoomResetBtn = toolbar.createEl('button', { text: '100%' });
    this.zoomResetBtn.addEventListener('click', () => {
      this.setZoom(1);
    });

    this.zoomInBtn = toolbar.createEl('button', { text: '+' });
    this.zoomInBtn.addEventListener('click', () => {
      this.setZoom(this.zoom + 0.1);
    });

    const refreshBtn = toolbar.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      if (this.mode === 'view') {
        void this.renderDiagram();
      } else {
        void this.reloadEditorFromFile();
      }
    });

    this.exportPngBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'PNG' });
    this.exportPngBtn.setAttr('aria-label', 'Save PNG image');
    this.exportPngBtn.addEventListener('click', () => {
      void this.exportDiagram('png');
    });

    this.exportSvgBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'SVG' });
    this.exportSvgBtn.setAttr('aria-label', 'Save SVG image');
    this.exportSvgBtn.addEventListener('click', () => {
      void this.exportDiagram('svg');
    });

    this.exportAsciiBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'ASCII' });
    this.exportAsciiBtn.setAttr('aria-label', 'Save ASCII art');
    this.exportAsciiBtn.addEventListener('click', () => {
      void this.exportDiagram('txt');
    });

    this.statusEl = toolbar.createDiv({ cls: 'puml-viewer-status' });
    this.statusEl.setText('Waiting for file...');
    this.zoomValueEl = toolbar.createDiv({ cls: 'puml-viewer-status' });

    this.imageWrapEl = viewContainer.createDiv({ cls: 'puml-viewer-image-wrap' });
    this.contentHostEl = this.imageWrapEl.createDiv({ cls: 'puml-viewer-content-host' });
    this.bindMainViewPanning();
    this.bindMainViewZoom();
    this.bindMainViewLinks();

    this.updateToolbarState();
    await this.loadFileFromState();

    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!this.currentFile || file.path !== this.currentFile.path) return;

        if (this.mode === 'view') {
          if (this.plugin.settings.autoRefresh) {
            await this.renderDiagram();
          }
          return;
        }

        if (!this.isDirty) {
          await this.reloadEditorFromFile();
          this.statusEl.setText(`Updated from disk: ${this.currentFile.name}`);
        } else {
          this.statusEl.setText('File changed on disk. Unsaved editor changes are kept.');
        }
      }),
    );
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);

    const viewState = (state ?? {}) as PUMLViewState;

    if (viewState.mode) {
      this.mode = viewState.mode;
      this.updateToolbarState();
    }

    if (!viewState.file) return;

    const file = this.app.vault.getAbstractFileByPath(viewState.file);
    if (file instanceof TFile) {
      // A change of file is a navigation step; Obsidian records it for the tab's back and forward arrows.
      if (this.currentFile?.path !== file.path) result.history = true;
      this.currentFile = file;
      this.resetDraftIfFileChanged();
      this.updateToolbarState();
      await this.renderActiveMode();
    }
  }

  getState(): Record<string, unknown> {
    return { file: this.currentFile?.path, mode: this.mode };
  }

  private async loadFileFromState(): Promise<void> {
    const state = this.leaf.getViewState().state;
    const mode = state?.mode;
    if (mode === 'view' || mode === 'edit') {
      this.mode = mode;
      this.updateToolbarState();
    }

    const candidates: string[] = [];
    if (typeof state?.file === 'string') candidates.push(state.file);

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && getDiagramTypeByExtension(activeFile.extension)) candidates.push(activeFile.path);

    const workspaceAny = this.app.workspace as unknown as { getLastOpenFiles?: () => string[] };
    const lastOpenFiles = workspaceAny.getLastOpenFiles?.() ?? [];
    for (const path of lastOpenFiles) {
      if (/\.(puml|mermaid|mmd|marmaid)$/i.test(path)) candidates.push(path);
    }

    const tried = new Set<string>();
    for (const path of candidates) {
      if (!path || tried.has(path)) continue;
      tried.add(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && getDiagramTypeByExtension(file.extension)) {
        this.currentFile = file;
        this.resetDraftIfFileChanged();
        this.updateToolbarState();
        await this.renderActiveMode();
        return;
      }
    }

    await this.renderActiveMode();
  }

  private async switchMode(mode: ViewMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    this.updateToolbarState();
    await this.renderActiveMode();
  }

  private async renderActiveMode(): Promise<void> {
    if (!this.contentHostEl) return;

    if (this.mode === 'edit') {
      await this.renderEditor();
      return;
    }

    await this.renderDiagram();
  }

  private updateToolbarState(): void {
    if (
      !this.viewModeBtn ||
      !this.editModeBtn ||
      !this.saveBtn ||
      !this.zoomOutBtn ||
      !this.zoomResetBtn ||
      !this.zoomInBtn ||
      !this.exportPngBtn ||
      !this.exportSvgBtn ||
      !this.exportAsciiBtn
    )
      return;

    this.viewModeBtn.toggleClass('is-active', this.mode === 'view');
    this.editModeBtn.toggleClass('is-active', this.mode === 'edit');
    this.saveBtn.disabled = this.mode !== 'edit';
    const zoomDisabled = this.mode !== 'view';
    this.zoomOutBtn.disabled = zoomDisabled;
    this.zoomResetBtn.disabled = zoomDisabled;
    this.zoomInBtn.disabled = zoomDisabled;
    const diagramType = this.getCurrentDiagramType();
    const exportDisabled = zoomDisabled || !this.currentFile || !diagramType;
    this.exportPngBtn.disabled = exportDisabled;
    this.exportSvgBtn.disabled = exportDisabled;
    this.exportAsciiBtn.disabled = exportDisabled || diagramType === 'mermaid';
    this.updateZoomLabel();
  }

  private resetDraftIfFileChanged(): void {
    const filePath = this.currentFile?.path ?? null;
    if (filePath && this.draftFilePath !== filePath) {
      this.editorDraft = null;
      this.isDirty = false;
      this.draftFilePath = filePath;
    }
  }

  private async renderEditor(): Promise<void> {
    this.contentHostEl.empty();
    this.contentHostEl.addClass('puml-viewer-content-host--editor');
    this.contentHostEl.removeClass('puml-viewer-content-host--view');
    this.imageWrapEl.removeClass('puml-viewer-image-wrap--view');
    this.imageWrapEl.removeClass('is-pan-enabled');
    this.imageWrapEl.removeClass('is-panning');
    this.isMainPanning = false;

    if (!this.currentFile) {
      this.statusEl.setText('No diagram file selected.');
      return;
    }

    try {
      const initialText =
        this.draftFilePath === this.currentFile.path && this.editorDraft !== null
          ? this.editorDraft
          : await this.app.vault.read(this.currentFile);

      this.editorDraft = initialText;
      this.draftFilePath = this.currentFile.path;

      const editorShell = this.contentHostEl.createDiv({ cls: 'puml-viewer-editor-shell' });
      this.editorGutterEl = editorShell.createDiv({ cls: 'puml-viewer-editor-gutter' });
      this.editorEl = editorShell.createEl('textarea', { cls: 'puml-viewer-editor' });
      this.editorEl.value = initialText;
      this.updateEditorLineNumbers(initialText);
      this.editorEl.addEventListener('input', () => {
        if (!this.editorEl) return;
        this.editorDraft = this.editorEl.value;
        this.isDirty = true;
        this.updateEditorLineNumbers(this.editorEl.value);
        this.statusEl.setText(`Editing: ${this.currentFile?.name ?? ''} (unsaved)`);
      });
      this.editorEl.addEventListener('scroll', () => {
        if (!this.editorEl || !this.editorGutterEl) return;
        this.editorGutterEl.scrollTop = this.editorEl.scrollTop;
      });
      this.editorEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void this.saveEditor();
        }
      });

      this.statusEl.setText(`Editing: ${this.currentFile.name}`);
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Failed to open editor.');

      const errorEl = this.contentHostEl.createDiv({ cls: 'puml-viewer-error' });
      errorEl.setText(
        `Failed to load source text.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async reloadEditorFromFile(): Promise<void> {
    if (!this.currentFile || !this.editorEl) return;

    try {
      const source = await this.app.vault.read(this.currentFile);
      this.editorDraft = source;
      this.draftFilePath = this.currentFile.path;
      this.editorEl.value = source;
      this.updateEditorLineNumbers(source);
      this.isDirty = false;
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Failed to reload source.');
    }
  }

  private async saveEditor(): Promise<void> {
    if (!this.currentFile || !this.editorEl || this.mode !== 'edit') return;

    try {
      const text = this.editorEl.value;
      await this.app.vault.modify(this.currentFile, text);
      this.editorDraft = text;
      this.draftFilePath = this.currentFile.path;
      this.isDirty = false;
      this.statusEl.setText(`Saved: ${this.currentFile.name}`);
      new Notice('Diagram source saved.');
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Save failed.');
      new Notice('Failed to save diagram source.');
    }
  }

  private async exportDiagram(format: DiagramFormat): Promise<void> {
    if (this.mode !== 'view' || !this.currentFile) return;
    const diagramType = this.getCurrentDiagramType();
    if (!diagramType) return;
    if (diagramType === 'mermaid' && format === 'txt') {
      new Notice('ASCII export is only available for plantuml.');
      return;
    }

    try {
      const source = await this.app.vault.read(this.currentFile);
      if (!source.trim()) {
        new Notice('Diagram file is empty.');
        return;
      }

      const defaultOutputPath = normalizePath(
        this.currentFile.path.replace(/\.[^/.]+$/i, `.${format}`),
      );
      const outputPath = await this.resolveExportOutputPath(defaultOutputPath);
      if (!outputPath) {
        this.statusEl.setText('Export cancelled.');
        return;
      }

      const response = await this.plugin.requestDiagram(source, format, diagramType);

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      const existing = this.app.vault.getAbstractFileByPath(outputPath);
      if (existing && !(existing instanceof TFile)) {
        throw new Error(`Cannot export: "${outputPath}" is not a file.`);
      }
      if (format === 'svg') {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('image/svg')) {
          throw new Error(`Expected SVG but got "${contentType}"`);
        }
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, response.text);
        } else {
          await this.app.vault.create(outputPath, response.text);
        }
      } else if (format === 'png') {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('image/png')) {
          throw new Error(`Expected PNG but got "${contentType}"`);
        }
        if (!response.arrayBuffer) {
          throw new Error('No PNG payload returned by render server');
        }

        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, response.arrayBuffer);
        } else {
          await this.app.vault.createBinary(outputPath, response.arrayBuffer);
        }
      } else {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('text/plain')) {
          throw new Error(`Expected text/plain but got "${contentType}"`);
        }
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, response.text);
        } else {
          await this.app.vault.create(outputPath, response.text);
        }
      }

      this.statusEl.setText(`Exported: ${outputPath}`);
      new Notice(`Diagram exported: ${outputPath}`);
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Export failed.');
      new Notice(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveExportOutputPath(defaultPath: string): Promise<string | null> {
    const existing = this.app.vault.getAbstractFileByPath(defaultPath);
    if (!existing) return defaultPath;

    if (!(existing instanceof TFile)) {
      return this.getNextAvailableExportPath(defaultPath);
    }

    const action = await this.askExportConflict(defaultPath);
    if (action === 'cancel') return null;
    if (action === 'overwrite') return defaultPath;
    return this.getNextAvailableExportPath(defaultPath);
  }

  private getNextAvailableExportPath(path: string): string {
    const slashIndex = path.lastIndexOf('/');
    const dir = slashIndex >= 0 ? path.slice(0, slashIndex) : '';
    const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
    const dotIndex = fileName.lastIndexOf('.');
    const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const ext = dotIndex > 0 ? fileName.slice(dotIndex) : '';

    let index = 1;
    while (index < 10_000) {
      const candidateName = `${base}-${index}${ext}`;
      const candidatePath = normalizePath(dir ? `${dir}/${candidateName}` : candidateName);
      if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
        return candidatePath;
      }
      index += 1;
    }

    throw new Error(`Could not find available file name for "${path}".`);
  }

  private askExportConflict(path: string): Promise<ExportConflictAction> {
    return new Promise((resolve) => {
      const modal = new ExportConflictModal(this.app, path, resolve);
      modal.open();
    });
  }

  private async renderDiagram(): Promise<void> {
    this.contentHostEl.empty();
    this.contentHostEl.removeClass('puml-viewer-content-host--editor');
    this.contentHostEl.addClass('puml-viewer-content-host--view');
    this.imageWrapEl.addClass('puml-viewer-image-wrap--view');
    this.editorGutterEl = null;
    this.editorEl = null;

    if (!this.currentFile) {
      this.statusEl.setText('No diagram file selected.');
      return;
    }
    const diagramType = this.getCurrentDiagramType();
    if (!diagramType) {
      this.statusEl.setText('Unsupported file type.');
      return;
    }
    const diagramLabel = diagramType === 'mermaid' ? 'Mermaid' : 'PlantUML';

    try {
      const source = await this.app.vault.read(this.currentFile);

      if (!source.trim()) {
        this.statusEl.setText('File is empty.');
        return;
      }

      const renderSource =
        diagramType === 'plantuml'
          ? applyHeaderLinkRules(
              applyLinkRules(source, this.plugin.settings.linkRules),
              this.currentFile.path,
              this.plugin.settings.headerLinkRules,
              (path) => this.app.vault.getAbstractFileByPath(path) !== null,
            )
          : source;
      this.statusEl.setText(`Rendering: ${this.currentFile.name}`);
      const renderRoot = this.contentHostEl.createDiv({ cls: 'puml-viewer-render-root' });
      const loadingEl = renderRoot.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });

      if (this.plugin.settings.imageFormat === 'svg') {
        const response = await this.plugin.requestDiagram(renderSource, 'svg', diagramType);

        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('image/svg')) {
          throw new Error(
            `Expected SVG but got "${contentType}". Check Server type/URL (for Kroki use https://kroki.io).`,
          );
        }
        if (!response.text.includes('<svg')) {
          throw new Error('Response is not SVG content.');
        }

        loadingEl.remove();
        const svgHost = renderRoot.createDiv();
        const svgEl = parseSvgMarkup(response.text);
        if (!svgEl) {
          throw new Error('Response is not valid SVG content.');
        }
        svgHost.appendChild(svgEl);
      } else {
        const img = renderRoot.createEl('img', {
          cls: 'puml-viewer-image puml-is-hidden',
        });
        const objectUrl = await this.plugin.fetchPngObjectUrl(renderSource, diagramType);
        img.src = objectUrl;
        img.alt = `${diagramLabel} diagram`;
        img.addEventListener(
          'load',
          () => {
            loadingEl.remove();
            img.removeClass('puml-is-hidden');
            this.statusEl.setText(`Rendered: ${this.currentFile?.name ?? ''}`);
            URL.revokeObjectURL(objectUrl);
            requestAnimationFrame(() => this.centerViewIfPending());
          },
          { once: true },
        );
        img.addEventListener(
          'error',
          () => {
            loadingEl.remove();
            this.statusEl.setText('Render failed.');
            const errorEl = renderRoot.createDiv({ cls: 'puml-viewer-error' });
            errorEl.setText('Failed to load PNG diagram.');
            URL.revokeObjectURL(objectUrl);
          },
          { once: true },
        );
      }

      if (this.plugin.settings.autoZoom100) {
        if (this.renderedFilePath !== this.currentFile.path) {
          this.renderedFilePath = this.currentFile.path;
          this.zoom = 1;
          this.needsCenter = true;
        }
        this.applyZoom();
      } else {
        this.renderedFilePath = this.currentFile.path;
        this.fitToWidth();
      }
      this.updateZoomLabel();
      this.refreshMainPanAvailability();
      // The stylesheet paints the viewer white; with the dark diagram theme the wrapper must be transparent.
      const darkActive = this.plugin.settings.invertInDarkMode && this.plugin.isDarkMode();
      for (const el of [this.imageWrapEl, this.contentHostEl, this.contentEl]) {
        if (el) el.style.background = darkActive ? 'var(--background-primary)' : '';
      }
      this.centerViewIfPending();
      if (this.plugin.settings.imageFormat === 'svg') {
        this.statusEl.setText(`Rendered: ${this.currentFile.name}`);
      }
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Render failed.');

      const errorEl = this.contentHostEl.createDiv({ cls: 'puml-viewer-error' });
      errorEl.setText(
        `Failed to render diagram.\n\n${error instanceof Error ? error.message : String(error)}`,
      );

      new Notice(`${diagramLabel} render failed.`);
    }
  }

  private setZoom(value: number): void {
    const nextZoom = Math.min(4, Math.max(0.25, Math.round(value * 100) / 100));
    this.zoom = nextZoom;
    this.applyZoom();
    this.refreshMainPanAvailability();
    this.updateZoomLabel();
  }

  private fitToWidth(): void {
    const renderRoot = this.contentHostEl?.querySelector<HTMLElement>('.puml-viewer-render-root');
    if (!renderRoot || !this.imageWrapEl) return;

    const imageEl = renderRoot.querySelector<HTMLImageElement>('.puml-viewer-image');
    if (imageEl) {
      const baseWidth = this.getImageBaseWidth(imageEl);
      if (!(baseWidth > 0)) {
        imageEl.addEventListener(
          'load',
          () => {
            this.fitToWidth();
          },
          { once: true },
        );
        return;
      }

      const availableWidth = Math.max(1, this.imageWrapEl.clientWidth - 24);
      this.setZoom(Math.min(1, availableWidth / baseWidth));
      return;
    }

    const svgEl = renderRoot.querySelector<SVGSVGElement>('svg');
    if (!svgEl) return;

    const baseWidth = this.getSvgBaseWidth(svgEl);
    if (!(baseWidth > 0)) return;

    const availableWidth = Math.max(1, this.imageWrapEl.clientWidth - 24);
    this.setZoom(Math.min(1, availableWidth / baseWidth));
  }

  private updateZoomLabel(): void {
    if (!this.zoomValueEl) return;
    this.zoomValueEl.setText(`Zoom: ${Math.round(this.zoom * 100)}%`);
  }

  private applyZoom(): void {
    const renderRoot = this.contentHostEl?.querySelector<HTMLElement>('.puml-viewer-render-root');
    if (!renderRoot) return;

    const imageEl = renderRoot.querySelector<HTMLImageElement>('.puml-viewer-image');
    if (imageEl) {
      const baseWidth = this.getImageBaseWidth(imageEl);

      if (baseWidth > 0) {
        imageEl.style.maxWidth = CSS_NONE;
        imageEl.style.width = `${Math.max(1, Math.round(baseWidth * this.zoom))}px`;
        imageEl.style.height = CSS_AUTO;
      } else {
        imageEl.addEventListener(
          'load',
          () => {
            this.applyZoom();
          },
          { once: true },
        );
      }
      return;
    }

    const svgEl = renderRoot.querySelector<SVGSVGElement>('svg');
    if (!svgEl) return;

    const baseWidth = this.getSvgBaseWidth(svgEl);

    if (!(baseWidth > 0)) return;

    svgEl.style.maxWidth = CSS_NONE;
    svgEl.style.width = `${Math.max(1, Math.round(baseWidth * this.zoom))}px`;
    svgEl.style.height = CSS_AUTO;
  }

  private bindMainViewZoom(): void {
    this.registerDomEvent(this.imageWrapEl, 'wheel', (event: WheelEvent) => {
      if (!event.ctrlKey || this.mode !== 'view') return;
      const renderRoot = this.contentHostEl?.querySelector<HTMLElement>('.puml-viewer-render-root');
      if (!renderRoot) return;
      event.preventDefault();

      const deltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      const oldZoom = this.zoom;
      const rootRect = renderRoot.getBoundingClientRect();
      const contentX = (event.clientX - rootRect.left) / oldZoom;
      const contentY = (event.clientY - rootRect.top) / oldZoom;

      this.setZoom(oldZoom * Math.exp(-deltaY * 0.0015));

      const newRect = renderRoot.getBoundingClientRect();
      this.imageWrapEl.scrollLeft += newRect.left - (event.clientX - contentX * this.zoom);
      this.imageWrapEl.scrollTop += newRect.top - (event.clientY - contentY * this.zoom);
    });
  }

  private centerViewIfPending(): void {
    if (!this.needsCenter || !this.imageWrapEl) return;
    const imageEl = this.contentHostEl?.querySelector<HTMLImageElement>('.puml-viewer-image');
    if (imageEl && !(imageEl.naturalWidth > 0)) return;
    if (!this.contentHostEl?.querySelector('.puml-viewer-render-root')) return;

    this.needsCenter = false;
    const wrap = this.imageWrapEl;
    wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
    wrap.scrollTop = 0;
  }

  private bindMainViewLinks(): void {
    this.registerDomEvent(this.imageWrapEl, 'click', (event: MouseEvent) => {
      if (event.button !== 0 || this.mode !== 'view') return;
      const link = (event.target as Element | null)?.closest?.('a') ?? null;
      if (!link) return;
      const href =
        link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      this.openDiagramLink(href, event);
    });
  }

  private openDiagramLink(rawHref: string, event: MouseEvent): void {
    if (!this.currentFile) return;
    this.plugin.openDiagramVaultLink(rawHref, event, this.currentFile.path, this.leaf);
  }

  private bindMainViewPanning(): void {
    this.registerDomEvent(this.imageWrapEl, 'mousedown', (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (this.mode !== 'view') return;
      if (!this.canMainPan()) return;

      this.isMainPanning = true;
      this.mainPanStartX = event.clientX;
      this.mainPanStartY = event.clientY;
      this.mainPanScrollLeft = this.imageWrapEl.scrollLeft;
      this.mainPanScrollTop = this.imageWrapEl.scrollTop;
      this.imageWrapEl.addClass('is-panning');
      event.preventDefault();
    });

    this.registerDomEvent(window, 'mousemove', (event: MouseEvent) => {
      if (!this.isMainPanning) return;
      const dx = event.clientX - this.mainPanStartX;
      const dy = event.clientY - this.mainPanStartY;
      this.imageWrapEl.scrollLeft = this.mainPanScrollLeft - dx;
      this.imageWrapEl.scrollTop = this.mainPanScrollTop - dy;
      event.preventDefault();
    });

    const stopPanning = () => {
      if (!this.isMainPanning) return;
      this.isMainPanning = false;
      this.imageWrapEl.removeClass('is-panning');
    };

    this.registerDomEvent(window, 'mouseup', stopPanning);
    this.registerDomEvent(this.imageWrapEl, 'mouseleave', stopPanning);
  }

  private canMainPan(): boolean {
    const hasHorizontal = this.imageWrapEl.scrollWidth > this.imageWrapEl.clientWidth + 1;
    const hasVertical = this.imageWrapEl.scrollHeight > this.imageWrapEl.clientHeight + 1;
    return hasHorizontal || hasVertical;
  }

  private refreshMainPanAvailability(): void {
    if (this.mode !== 'view') {
      this.imageWrapEl.removeClass('is-pan-enabled');
      return;
    }
    this.imageWrapEl.toggleClass('is-pan-enabled', this.canMainPan());
  }

  private getImageBaseWidth(imageEl: HTMLImageElement): number {
    const storedBaseWidth = Number(imageEl.dataset.baseWidth ?? 0);
    const measuredWidth =
      imageEl.naturalWidth || imageEl.clientWidth || imageEl.getBoundingClientRect().width;
    const baseWidth = storedBaseWidth > 0 ? storedBaseWidth : measuredWidth;
    if (baseWidth > 0) {
      imageEl.dataset.baseWidth = String(baseWidth);
    }
    return baseWidth;
  }

  private getSvgBaseWidth(svgEl: SVGSVGElement): number {
    const storedBaseWidth = Number(svgEl.dataset.baseWidth ?? 0);
    let baseWidth = storedBaseWidth;
    if (!(baseWidth > 0)) {
      const viewBoxWidth = svgEl.viewBox?.baseVal?.width ?? 0;
      const widthAttr = Number.parseFloat(svgEl.getAttribute('width') ?? '0');
      const measuredWidth = svgEl.getBoundingClientRect().width;
      baseWidth = viewBoxWidth || widthAttr || measuredWidth;
    }
    if (baseWidth > 0) {
      svgEl.dataset.baseWidth = String(baseWidth);
    }
    return baseWidth;
  }

  private updateEditorLineNumbers(text: string): void {
    if (!this.editorGutterEl) return;
    this.editorGutterEl.empty();

    const lineCount = Math.max(1, text.split('\n').length);
    for (let i = 1; i <= lineCount; i++) {
      this.editorGutterEl.createDiv({ cls: 'puml-viewer-editor-line', text: String(i) });
    }
  }
}

class ExportConflictModal extends Modal {
  private resolved = false;
  private readonly onResolve: (action: ExportConflictAction) => void;
  private readonly path: string;

  constructor(app: App, path: string, onResolve: (action: ExportConflictAction) => void) {
    super(app);
    this.path = path;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'File already exists' });
    contentEl.createEl('p', {
      text: `The file "${this.path}" already exists. Overwrite it or save as a new file?`,
    });

    const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' });

    const overwriteBtn = buttonRow.createEl('button', {
      text: 'Overwrite',
      cls: 'mod-warning',
    });
    overwriteBtn.addEventListener('click', () => this.finish('overwrite'));

    const newFileBtn = buttonRow.createEl('button', {
      text: 'Save as new',
      cls: 'mod-cta',
    });
    newFileBtn.addEventListener('click', () => this.finish('new-file'));

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.finish('cancel'));
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve('cancel');
  }

  private finish(action: ExportConflictAction): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(action);
    this.close();
  }
}

class PUMLViewerSettingTab extends PluginSettingTab {
  plugin: PUMLViewerPlugin;

  constructor(app: App, plugin: PUMLViewerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('Plantuml viewer').setHeading();

    new Setting(containerEl)
      .setName('Server type')
      .setDesc('Choose which server URL to use for rendering.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('plantuml', 'Plantuml')
          .addOption('kroki', 'Kroki')
          .addOption('local', 'Local')
          .setValue(this.plugin.settings.serverType)
          .onChange(async (value) => {
            if (value !== 'plantuml' && value !== 'kroki' && value !== 'local') return;
            this.plugin.settings.serverType = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Plantuml server URL')
      .setDesc('Example: https://www.plantuml.com/plantuml')
      .addText((text) =>
        text
          .setPlaceholder('https://www.plantuml.com/plantuml')
          .setValue(this.plugin.settings.plantumlServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.plantumlServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Kroki URL')
      .setDesc('Example: https://kroki.io')
      .addText((text) =>
        text
          .setPlaceholder('https://kroki.io')
          .setValue(this.plugin.settings.krokiServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.krokiServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Kroki diagram type')
      .setDesc('Default diagram type for kroki requests outside explicit code block language.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('plantuml', 'Plantuml')
          .addOption('mermaid', 'Mermaid')
          .setValue(this.plugin.settings.krokiDiagramType)
          .onChange(async (value) => {
            if (value !== 'plantuml' && value !== 'mermaid') return;
            this.plugin.settings.krokiDiagramType = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Local URL')
      .setDesc('Use a local server URL.')
      .addText((text) =>
        text
          .setPlaceholder('Local server URL')
          .setValue(this.plugin.settings.localServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.localServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Image format')
      .setDesc('SVG is recommended.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('svg', 'SVG')
          .addOption('png', 'PNG')
          .setValue(this.plugin.settings.imageFormat)
          .onChange(async (value) => {
            if (value !== 'svg' && value !== 'png') return;
            this.plugin.settings.imageFormat = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('CodeFlow specific settings').setHeading();

    new Setting(containerEl)
      .setName('Auto zoom to 100%')
      .setDesc('Open each diagram at 100% and centred. When off, diagrams fit to the pane width.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoZoom100).onChange(async (value) => {
          this.plugin.settings.autoZoom100 = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Invert diagrams in dark mode')
      .setDesc('Shows diagrams with a dark background and light lines when Obsidian uses its dark theme. Colours keep their hue.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.invertInDarkMode).onChange(async (value) => {
          this.plugin.settings.invertInDarkMode = value;
          await this.plugin.saveSettings();
          this.plugin.applyDiagramInversion();
        }),
      );

    containerEl.createEl('h3', { text: 'Link click behaviour' });
    containerEl.createEl('p', {
      text: 'Plain click opens a link in the same tab. Hold the chosen key while clicking to open it in a new tab, a split, or a new window. Applies to every link in the viewer. Set a key to None to disable it.',
    });
    const modifierOptions: Record<ModifierKey, string> = {
      none: 'None',
      ctrl: 'Ctrl',
      meta: 'Meta (Cmd on macOS)',
      alt: 'Alt',
      shift: 'Shift',
    };
    const modifierSetting = (name: string, key: 'tab' | 'split' | 'window'): void => {
      new Setting(containerEl)
        .setName(name)
        .addDropdown((dropdown) => {
          for (const [value, label] of Object.entries(modifierOptions)) dropdown.addOption(value, label);
          dropdown.setValue(this.plugin.settings.linkModifiers[key]).onChange(async (value) => {
            this.plugin.settings.linkModifiers[key] = value as ModifierKey;
            await this.plugin.saveSettings();
          });
        });
    };
    modifierSetting('Key for new tab', 'tab');
    modifierSetting('Key for split view', 'split');
    modifierSetting('Key for new window', 'window');

    new Setting(containerEl)
      .setName('Auto refresh')
      .setDesc('Automatically re-render diagram when the source file changes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
          this.plugin.settings.autoRefresh = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Embedded block default view')
      .setDesc('Choose what to show first in embedded diagram blocks.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('diagram', 'Diagram')
          .addOption('code', 'Code')
          .setValue(this.plugin.settings.embeddedDefaultView)
          .onChange(async (value) => {
            if (value !== 'diagram' && value !== 'code') return;
            this.plugin.settings.embeddedDefaultView = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Embedded diagram alignment')
      .setDesc('Default alignment for diagrams in embedded diagram blocks.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('left', 'Left')
          .addOption('center', 'Center')
          .addOption('right', 'Right')
          .setValue(this.plugin.settings.embeddedDiagramAlign)
          .onChange(async (value) => {
            if (value !== 'left' && value !== 'center' && value !== 'right') return;
            this.plugin.settings.embeddedDiagramAlign = value;
            await this.plugin.saveSettings();
            this.plugin.rerenderMarkdownPreviews();
          }),
      );

    containerEl.createEl('h3', { text: 'Link rules' });
    containerEl.createEl('p', {
      text: 'Applied in order to PlantUML source before rendering. The file itself is not changed. Line rules run on every line. Class member rules run on members inside class blocks, where {class} is the class name. Lines that already contain a link are skipped.',
    });

    this.plugin.settings.linkRules.forEach((rule, index) => {
      new Setting(containerEl)
        .setName(`Rule ${index + 1}`)
        .addDropdown((dropdown) =>
          dropdown
            .addOption('line', 'Line')
            .addOption('classMember', 'Class member')
            .setValue(rule.scope)
            .onChange(async (value) => {
              rule.scope = value === 'classMember' ? 'classMember' : 'line';
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('Search regex')
            .setValue(rule.search)
            .onChange(async (value) => {
              rule.search = value;
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('Replacement')
            .setValue(rule.replace)
            .onChange(async (value) => {
              rule.replace = value;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('Remove rule')
            .onClick(async () => {
              this.plugin.settings.linkRules.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText('Add rule').onClick(async () => {
        this.plugin.settings.linkRules.push({ search: '', replace: '', scope: 'line' });
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    containerEl.createEl('h3', { text: 'Header link rules' });
    containerEl.createEl('p', {
      text: 'Adds a header with links to the open PlantUML file before rendering. The file itself is not changed. The path check is a regex on the vault path; its named groups (for example comp, prefix) fill {name} placeholders in the target path and label. A rule never links to the open file, and a link is added only if its target exists in the vault.',
    });

    this.plugin.settings.headerLinkRules.forEach((rule, index) => {
      new Setting(containerEl)
        .setName(`Header rule ${index + 1}`)
        .addText((text) =>
          text
            .setPlaceholder('Path check regex')
            .setValue(rule.pathMatch)
            .onChange(async (value) => {
              rule.pathMatch = value;
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('Target path, e.g. {prefix}activity/{comp}_Run.puml')
            .setValue(rule.targetPath)
            .onChange(async (value) => {
              rule.targetPath = value;
              await this.plugin.saveSettings();
            }),
        )
        .addText((text) =>
          text
            .setPlaceholder('Label, e.g. {comp}_Run')
            .setValue(rule.label)
            .onChange(async (value) => {
              rule.label = value;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon('trash')
            .setTooltip('Remove header rule')
            .onClick(async () => {
              this.plugin.settings.headerLinkRules.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText('Add header rule').onClick(async () => {
        this.plugin.settings.headerLinkRules.push({ pathMatch: '', targetPath: '', label: '' });
        await this.plugin.saveSettings();
        this.display();
      }),
    );
  }
}