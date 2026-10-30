import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { backend, desktop, errorMessage } from '../../lib/backend';
import type { FontFamily, Settings } from '../../lib/backend';

/** 设置框中可修改的设置项，不含版本号。 */
export type SettingValues = Omit<Settings, 'version'>;

/** 各设置项的默认值，与 Rust 端 `Settings::default` 一致。 */
export const DEFAULT_SETTINGS: SettingValues = {
  fontFamily: '',
  fontSize: 13,
  tabSize: 4,
  wrap: false,
  autoSave: true,
  changeTree: false,
  unifiedDiff: false,
};

/** 字号范围，与 Rust 端校验一致。 */
export const FONT_SIZE = { min: 10, max: 24 };

/** CSS 通用字体族，不能加引号。 */
const GENERIC_FONTS = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'ui-monospace',
  'system-ui',
]);

const mac = /Mac/.test(navigator.platform);

/**
 * macOS 的 SF Mono 是系统内部字体，不能按名称引用，WebKit 通过 `ui-monospace` 提供；
 * 设置中仍保存为 SF Mono，应用时转换。其他平台的 WebView 不支持，不显示此项。
 */
const SF_MONO = 'SF Mono';
const SYSTEM_MONO: FontFamily | null = mac
  ? { name: SF_MONO, local: null, monospaced: true }
  : null;

/** 把用户输入的字体名（逗号分隔、可不加引号）转为 CSS font-family，每个名称加双引号。 */
export function cssFontFamily(value: string): string {
  return value
    .split(',')
    .map((name) => name.replace(/['"]/g, '').trim())
    .filter(Boolean)
    .map((name) =>
      GENERIC_FONTS.has(name)
        ? name
        : mac && name.toLowerCase() === SF_MONO.toLowerCase()
          ? `ui-monospace, "${name}"`
          : `"${name}"`,
    )
    .join(', ');
}

/**
 * 补充等宽判断：部分字体（如 Monaco）没有设置等宽标记，按窄字母与宽字母的宽度是否相同判断；
 * 缺少拉丁字母的字体会回退到比例字体 serif，不会误判为等宽。
 */
function withMonospace(families: FontFamily[]): FontFamily[] {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return families;
  const width = (font: string, text: string) => {
    context.font = `40px ${cssFontFamily(font)}, serif`;
    return context.measureText(text).width;
  };
  return families.map((family) =>
    family.monospaced ||
    Math.abs(
      width(family.name, 'iiiiiiiiii') - width(family.name, 'MMMMMMMMMM'),
    ) < 0.5
      ? { ...family, monospaced: true }
      : family,
  );
}

/** 字体下拉列表的一项；font 为空字符串表示默认字体。 */
interface FontOption {
  font: string;
  local: string | null;
}

/** 字体下拉列表的分组。 */
interface FontGroup {
  title: string | null;
  options: FontOption[];
}

/** 按输入过滤字体，英文名或中文名包含即可；等宽字体在前，便于写代码时选择。 */
function fontGroups(families: FontFamily[], query: string): FontGroup[] {
  const text = query.trim().toLowerCase();
  const matched = families.filter(
    (family) =>
      !text ||
      family.name.toLowerCase().includes(text) ||
      Boolean(family.local?.toLowerCase().includes(text)),
  );
  const option = (family: FontFamily) => ({
    font: family.name,
    local: family.local,
  });
  return [
    ...(text ? [] : [{ title: null, options: [{ font: '', local: null }] }]),
    {
      title: '等宽字体',
      options: matched.filter((family) => family.monospaced).map(option),
    },
    {
      title: '其他字体',
      options: matched.filter((family) => !family.monospaced).map(option),
    },
  ].filter((group) => group.options.length);
}

interface Props {
  values: SettingValues;
  /** 修改快捷键提示中的修饰键（⌘ 或 Ctrl）。 */
  mod: string;
  onChange: (patch: Partial<SettingValues>) => void;
  onClose: () => void;
}

/** 设置框：按编辑器、Git 分组，修改后立即生效并由上层写入 ~/.nib/settings.json。 */
export function SettingsDialog({ values, mod, onChange, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  // 字体在失焦、回车或选择列表项时才应用，避免输入过程中反复写盘。
  const [fontDraft, setFontDraft] = useState(values.fontFamily);
  const [fontList, setFontList] = useState(false);
  const [fontIndex, setFontIndex] = useState(-1);
  // 下拉列表的过滤文字；点箭头打开时为空，显示全部字体。
  const [fontQuery, setFontQuery] = useState('');
  const [families, setFamilies] = useState<FontFamily[] | null>(null);
  const [fontsError, setFontsError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const groups = useMemo(
    () => fontGroups(families ?? [], fontQuery),
    [families, fontQuery],
  );
  const options = groups.flatMap((group) => group.options);

  // 打开设置时在后台读取系统字体，Rust 端只在首次调用时扫描。
  useEffect(() => {
    if (!desktop) {
      setFamilies([]);
      return;
    }
    let current = true;
    backend
      .systemFonts()
      .then((next) => {
        if (current)
          setFamilies([
            ...(SYSTEM_MONO ? [SYSTEM_MONO] : []),
            ...withMonospace(next),
          ]);
      })
      .catch((error) => {
        if (!current) return;
        setFamilies([]);
        setFontsError(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, []);

  // 键盘切换时让当前项保持可见。
  useEffect(() => {
    if (fontList && fontIndex >= 0)
      listRef.current
        ?.querySelector(`#settings-font-${fontIndex}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [fontList, fontIndex]);

  useEffect(() => {
    setFontDraft(values.fontFamily);
  }, [values.fontFamily]);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('input, select')?.focus();
  }, []);

  function applyFont(value = fontDraft) {
    const font = value.trim();
    setFontDraft(font);
    if (font !== values.fontFamily) onChange({ fontFamily: font });
  }

  function pickFont(font: string) {
    applyFont(font);
    setFontList(false);
  }

  function openFontList() {
    const all = fontGroups(families ?? [], '').flatMap(
      (group) => group.options,
    );
    setFontQuery('');
    setFontIndex(
      Math.max(
        0,
        all.findIndex((option) => option.font === fontDraft.trim()),
      ),
    );
    setFontList(true);
  }

  function toggle(key: 'wrap' | 'autoSave', label: string, note: string) {
    return (
      <label className="settings-row">
        <span>
          {label}
          <small>{note}</small>
        </span>
        <input
          type="checkbox"
          checked={values[key]}
          onChange={(event) => onChange({ [key]: event.target.checked })}
        />
      </label>
    );
  }

  function choice(
    label: string,
    note: string,
    value: boolean,
    options: [string, string],
    onPick: (value: boolean) => void,
  ) {
    return (
      <div className="settings-row" role="group" aria-label={label}>
        <span>
          {label}
          <small>{note}</small>
        </span>
        <div className="settings-segment">
          {options.map((text, index) => (
            <button
              key={text}
              className={value === (index === 1) ? 'active' : ''}
              aria-pressed={value === (index === 1)}
              onClick={() => onPick(index === 1)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="unsaved-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            applyFont();
            onClose();
          }
        }}
      >
        <div className="popover-title">
          <h2 id="settings-title">设置</h2>
          <button
            className="icon-button"
            aria-label="关闭设置"
            onClick={() => {
              applyFont();
              onClose();
            }}
          >
            <X size={14} />
          </button>
        </div>

        <section aria-labelledby="settings-editor">
          <h3 id="settings-editor">编辑器</h3>
          <div className="settings-row">
            <span>
              <label htmlFor="settings-font">字体</label>
              <small>从系统字体中选择，或输入名称，多个用逗号分隔</small>
            </span>
            <div
              className="settings-combo"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setFontList(false);
                  applyFont();
                }
              }}
            >
              <input
                id="settings-font"
                className="settings-input"
                role="combobox"
                aria-expanded={fontList}
                aria-controls="settings-font-list"
                aria-autocomplete="none"
                aria-activedescendant={
                  fontList && fontIndex >= 0
                    ? `settings-font-${fontIndex}`
                    : undefined
                }
                value={fontDraft}
                placeholder="默认等宽字体"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => {
                  // 输入时按名称过滤列表，回车应用输入的文字，除非用方向键选了某项。
                  setFontDraft(event.target.value);
                  setFontQuery(event.target.value);
                  setFontIndex(-1);
                  setFontList(true);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (!fontList) openFontList();
                    else if (options.length)
                      setFontIndex(
                        (index) =>
                          (Math.max(index, event.key === 'ArrowDown' ? -1 : 0) +
                            (event.key === 'ArrowDown' ? 1 : -1) +
                            options.length) %
                          options.length,
                      );
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (fontList && options[fontIndex])
                      pickFont(options[fontIndex].font);
                    else applyFont();
                  } else if (event.key === 'Escape' && fontList) {
                    // 先收起列表，再按一次才关闭设置框。
                    event.preventDefault();
                    event.stopPropagation();
                    setFontList(false);
                  }
                }}
              />
              <button
                className="settings-combo-toggle"
                tabIndex={-1}
                aria-label="选择字体"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (fontList) setFontList(false);
                  else openFontList();
                  dialog.current
                    ?.querySelector<HTMLInputElement>('#settings-font')
                    ?.focus();
                }}
              >
                <ChevronDown size={13} />
              </button>
              {fontList && (
                <ul
                  ref={listRef}
                  id="settings-font-list"
                  className="settings-combo-list"
                  role="listbox"
                  aria-label="字体"
                >
                  {families === null && (
                    <li className="settings-combo-note">读取系统字体…</li>
                  )}
                  {fontsError && (
                    <li className="settings-combo-note">
                      读取系统字体失败：{fontsError}
                    </li>
                  )}
                  {families !== null && !options.length && (
                    <li className="settings-combo-note">
                      没有匹配的字体，回车使用输入的名称
                    </li>
                  )}
                  {groups.map((group) => (
                    <li key={group.title ?? 'default'} role="presentation">
                      {group.title && (
                        <div
                          className="settings-combo-group"
                          role="presentation"
                        >
                          {group.title}
                        </div>
                      )}
                      {group.options.map((option) => {
                        const index = options.indexOf(option);
                        const chosen = option.font === fontDraft.trim();
                        return (
                          <div
                            key={option.font || 'default'}
                            id={`settings-font-${index}`}
                            role="option"
                            aria-selected={chosen}
                            className={`settings-combo-option ${index === fontIndex ? 'active' : ''}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setFontIndex(index)}
                            onClick={() => pickFont(option.font)}
                          >
                            <span className="settings-combo-check">
                              {chosen && <Check size={12} />}
                            </span>
                            <span className="settings-combo-name">
                              {option.font || '默认等宽字体'}
                              {option.local && <small>{option.local}</small>}
                            </span>
                            {/* 预览用该字体显示，名称本身用界面字体，保证列表整齐。 */}
                            <span
                              className="settings-combo-preview"
                              aria-hidden="true"
                              style={
                                option.font
                                  ? {
                                      fontFamily: `${cssFontFamily(option.font)}, var(--editor-font)`,
                                    }
                                  : { fontFamily: 'var(--editor-font)' }
                              }
                            >
                              Aa 0O 1l
                            </span>
                          </div>
                        );
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="settings-row" role="group" aria-label="字号">
            <span>
              字号
              <small>
                {mod} + / − 调整，{mod} 0 还原
              </small>
            </span>
            <div className="settings-stepper">
              <button
                aria-label="减小字号"
                disabled={values.fontSize <= FONT_SIZE.min}
                onClick={() => onChange({ fontSize: values.fontSize - 1 })}
              >
                −
              </button>
              <span>{values.fontSize} px</span>
              <button
                aria-label="增大字号"
                disabled={values.fontSize >= FONT_SIZE.max}
                onClick={() => onChange({ fontSize: values.fontSize + 1 })}
              >
                +
              </button>
            </div>
          </div>
          <label className="settings-row">
            <span>
              缩进宽度
              <small>按 Tab 插入的空格数，也是 Tab 的显示宽度</small>
            </span>
            <select
              className="settings-input"
              value={values.tabSize}
              onChange={(event) =>
                onChange({ tabSize: Number(event.target.value) })
              }
            >
              {[2, 4, 8].map((size) => (
                <option key={size} value={size}>
                  {size} 个空格
                </option>
              ))}
            </select>
          </label>
          {toggle('wrap', '自动换行', '长行在窗口宽度处折行显示')}
          {toggle(
            'autoSave',
            '自动保存',
            '停止输入 1 秒、切换标签或窗口失焦时保存',
          )}
        </section>

        <section aria-labelledby="settings-git">
          <h3 id="settings-git">Git</h3>
          {choice(
            '变更列表',
            '提交面板中变更文件的排列方式',
            values.changeTree,
            ['平铺', '按目录分组'],
            (changeTree) => onChange({ changeTree }),
          )}
          {choice(
            'Diff 视图',
            '查看文件变更时的对比方式',
            values.unifiedDiff,
            ['左右对比', '统一视图'],
            (unifiedDiff) => onChange({ unifiedDiff }),
          )}
        </section>

        <div className="settings-footer">
          <span>保存在 ~/.nib/settings.json，所有窗口共用</span>
          <button
            className="secondary-button"
            onClick={() => {
              setFontDraft(DEFAULT_SETTINGS.fontFamily);
              onChange(DEFAULT_SETTINGS);
            }}
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
