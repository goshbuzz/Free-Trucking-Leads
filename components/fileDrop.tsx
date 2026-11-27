'use client';

import { useId, useRef, useState } from 'react';
import { UploadIcon } from './icons';

interface FileDropProps {
  file: File | null;
  onFile: (file: File | null) => void;
  onError: (message: string) => void;
  maxBytes: number;
  maxRows: number;
  disabled?: boolean;
  accept?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The file picker doubles as a drop target. Both paths validate before the file
 * reaches the parent so a 400 MB export never gets read into memory.
 */
export function FileDrop({
  file,
  onFile,
  onError,
  maxBytes,
  maxRows,
  disabled,
  accept = '.csv,.txt,text/csv',
}: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();

  const acceptFile = (candidate: File | null | undefined) => {
    if (!candidate) return;
    if (candidate.size > maxBytes) {
      onError(
        `${candidate.name} is ${formatBytes(candidate.size)}. The limit is ${formatBytes(maxBytes)} per file — split the list and run it in batches.`,
      );
      return;
    }
    const name = candidate.name.toLowerCase();
    if (!name.endsWith('.csv') && !name.endsWith('.txt') && candidate.type !== 'text/csv') {
      onError('Upload a .csv or .txt file. Excel files should be saved as CSV first.');
      return;
    }
    onFile(candidate);
  };

  return (
    <div
      className={`dropzone${dragging ? ' dropzone--active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (disabled) return;
        acceptFile(event.dataTransfer.files?.[0]);
      }}
    >
      <div className="dropzone__empty">
        <UploadIcon className="dropzone__icon" />
        <p className="dropzone__title">Choose a CSV or drop it here</p>
        <p className="dropzone__hint">
          Include a DOT, DOT Number, or USDOT column.
          <br />
          Up to {new Intl.NumberFormat('en-US').format(maxRows)} rows · {formatBytes(maxBytes)} per file
        </p>
      </div>

      <div>
        <label className="filedrop__label" htmlFor={id}>
          CSV file
        </label>
        <div className="filedrop__control">
          <button
            type="button"
            className="filedrop__button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
          >
            Choose File
          </button>
          <span className={`filedrop__value${file ? '' : ' filedrop__value--empty'}`} title={file?.name}>
            {file ? file.name : 'No file chosen'}
          </span>
          <input
            id={id}
            ref={inputRef}
            type="file"
            accept={accept}
            className="visually-hidden"
            disabled={disabled}
            onChange={(event) => {
              acceptFile(event.target.files?.[0]);
              // Reset so picking the same file twice still fires a change event.
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {file ? (
        <p className="filedrop__file">
          <strong>{file.name}</strong> · {formatBytes(file.size)}
        </p>
      ) : null}
    </div>
  );
}
