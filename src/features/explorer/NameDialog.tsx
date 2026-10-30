import { useEffect, useRef, useState } from 'react';

/** 输入名称的请求：新建文件、新建目录、重命名，或带第二个输入框的表单（如远程仓库名与地址）。 */
export interface NameRequest {
  title: string;
  initial: string;
  confirm: string;
  /** 输入框的说明；有 extra 时显示在输入框上方。 */
  label?: string;
  placeholder?: string;
  /** 第二个必填输入框。 */
  extra?: { label: string; initial: string; placeholder?: string };
  /** 返回错误说明时保留对话框并显示，返回 null 时关闭；extra 为第二个输入框的值。 */
  submit: (name: string, extra: string) => Promise<string | null>;
}

interface Props {
  request: NameRequest;
  onClose: () => void;
}

/** 名称输入框；重命名时默认选中扩展名之前的部分，与 GoLand 一致。 */
export function NameDialog({ request, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(request.initial);
  const [extra, setExtra] = useState(request.extra?.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready =
    Boolean(name.trim()) && (!request.extra || Boolean(extra.trim()));

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    // 地址等带说明的输入框全选，文件名只选扩展名之前的部分。
    const dot = request.label ? -1 : request.initial.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : request.initial.length);
  }, [request]);

  async function submit() {
    if (submitting || !ready) return;
    setSubmitting(true);
    const message = await request.submit(name, extra);
    setSubmitting(false);
    if (message) setError(message);
    else onClose();
  }

  function field(
    value: string,
    onChange: (value: string) => void,
    label: string,
    placeholder?: string,
    ref?: React.RefObject<HTMLInputElement | null>,
  ) {
    return (
      <input
        ref={ref}
        className="name-input"
        aria-label={label}
        aria-invalid={Boolean(error)}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={submitting}
        onChange={(event) => {
          onChange(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
    );
  }

  return (
    <div className="modal-backdrop">
      <div
        className="unsaved-dialog name-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !submitting) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2 id="name-title">{request.title}</h2>
        {request.extra ? (
          <>
            <label className="name-label">
              <span>{request.label ?? '名称'}</span>
              {field(
                name,
                setName,
                request.label ?? '名称',
                request.placeholder,
                input,
              )}
            </label>
            <label className="name-label">
              <span>{request.extra.label}</span>
              {field(
                extra,
                setExtra,
                request.extra.label,
                request.extra.placeholder,
              )}
            </label>
          </>
        ) : (
          field(
            name,
            setName,
            request.label ?? '名称',
            request.placeholder,
            input,
          )
        )}
        <p className={`name-error ${error ? 'visible' : ''}`} role="alert">
          {error ?? ' '}
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="primary-button"
            disabled={submitting || !ready}
            onClick={() => void submit()}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
