'use client';

import { useState } from 'react';
import { Modal } from '@/components/modal';

export interface AskField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** Renders right-to-left in the Urdu face. */
  urdu?: boolean;
  required?: boolean;
}

/**
 * The replacement for `window.prompt`.
 *
 * A browser prompt is not part of the product: it carries the page's URL in
 * its title, cannot be styled, cannot hold two fields, cannot say what the
 * answer is for, and on some browsers can be suppressed entirely — in which
 * case the feature silently stops working. It was standing in for a dialog
 * while the screens were being built; this is the dialog.
 *
 * Deliberately small. It asks for one or two short strings and nothing else;
 * anything richer belongs in a form of its own.
 */
export function Ask({
  title,
  description,
  fields,
  confirmLabel = 'Save',
  onCancel,
  onSubmit,
}: {
  title: string;
  description?: string;
  fields: AskField[];
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((field) => [field.key, field.value ?? ''])),
  );

  const missing = fields.some((field) => field.required && !values[field.key]?.trim());

  return (
    <Modal title={title} onClose={onCancel}>
      <form
        className="stack"
        style={{ gap: 'var(--sp-4)' }}
        onSubmit={(event) => {
          event.preventDefault();
          if (missing) return;
          onSubmit(
            Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])),
          );
        }}
      >
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="dialog-title">{title}</h2>
          {description ? <p className="sm muted">{description}</p> : null}
        </div>

        {fields.map((field) => (
          <div className="field" key={field.key}>
            <label className="field-label" htmlFor={`ask-${field.key}`}>
              {field.label}
            </label>
            <input
              id={`ask-${field.key}`}
              className={field.urdu ? 'input input-ur' : 'input'}
              {...(field.urdu ? { lang: 'ur', dir: 'rtl' as const } : {})}
              placeholder={field.placeholder}
              value={values[field.key] ?? ''}
              onChange={(event) =>
                setValues({ ...values, [field.key]: event.target.value })
              }
            />
            {field.hint ? <span className="field-hint">{field.hint}</span> : null}
          </div>
        ))}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={missing}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * A yes-or-no dialog, for the destructive answers `window.confirm` was giving.
 *
 * The consequence goes in the body rather than being left for somebody to
 * infer — "it has 3 dishes in it" is the fact that decides the answer.
 */
export function Confirm({
  title,
  body,
  confirmLabel = 'Delete',
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="stack" style={{ gap: 6 }}>
        <h2 className="dialog-title">{title}</h2>
        <p className="sm muted">{body}</p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
