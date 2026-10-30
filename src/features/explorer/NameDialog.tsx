import { useEffect, useRef, useState } from 'react';

/** 输入名称的请求：新建文件、新建目录或重命名。 */
export interface NameRequest {
  title: string;
  initial: string;
  confirm: string;
  /** 返回错误说明时保留对话框并显示，返回 null 时关闭。 */
  submit: (name: string) => Promise<string | null>;
}

interface Props {
  request: NameRequest;
  onClose: () => void;
}

/** 名称输入框；重命名时默认选中扩展名之前的部分，与 GoLand 一致。 */
export function NameDialog({ request, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(request.initial);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    const dot = request.initial.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : request.initial.length);
  }, [request]);

  async function submit() {
    if (submitting || !name.trim()) return;
    setSubmitting(true);
    const message = await request.submit(name);
    setSubmitting(false);
    if (message) setError(message);
    else onClose();
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
        <input
          ref={input}
          className="name-input"
          aria-label="名称"
          aria-invalid={Boolean(error)}
          value={name}
          spellCheck={false}
          disabled={submitting}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
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
            disabled={submitting || !name.trim()}
            onClick={() => void submit()}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
