import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PdfJsPageRenderer } from '../adapters/pdf/pdfjsAdapter';
import {
  pdfRectToViewport,
  type PdfPageRenderer,
  type PdfTextSpan,
} from '../adapters/pdf/types';
import type {
  FormFieldValue,
  PdfFormField,
  PdfInspection,
  PdfPageMetrics,
  PdfSignatureReport,
} from '../types';

interface PdfWorkspaceProps {
  rawPdf: Uint8Array;
  inspection: PdfInspection;
  zoom: number;
  jumpToPageRequest: { page: number; nonce: number } | null;
  formValues: Record<string, FormFieldValue>;
  dirtyFields: Set<string>;
  onFieldChange: (fieldName: string, value: FormFieldValue) => void;
  onVisiblePageChange: (pageIndex: number) => void;
  onSelectSignature: (sig: PdfSignatureReport | null) => void;
}

interface PdfPageCanvasProps {
  renderer: PdfPageRenderer;
  rendererVersion: number;
  metrics: PdfPageMetrics;
  scale: number;
  fields: PdfFormField[];
  signatures: PdfSignatureReport[];
  formValues: Record<string, FormFieldValue>;
  dirtyFields: Set<string>;
  onFieldChange: (fieldName: string, value: FormFieldValue) => void;
  onSelectSignature: (sig: PdfSignatureReport | null) => void;
  registerPageEl: (pageIndex: number, el: HTMLDivElement | null) => void;
}

const PdfPageView: React.FC<PdfPageCanvasProps> = ({
  renderer,
  rendererVersion,
  metrics,
  scale,
  fields,
  signatures,
  formValues,
  dirtyFields,
  onFieldChange,
  onSelectSignature,
  registerPageEl,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [textSpans, setTextSpans] = useState<PdfTextSpan[]>([]);

  const width = Math.round(metrics.width * scale);
  const height = Math.round(metrics.height * scale);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    renderer
      .renderPage(metrics.pageIndex, canvas, scale)
      .then(() => renderer.getTextSpans(metrics.pageIndex, scale))
      .then((spans) => {
        if (!cancelled) setTextSpans(spans);
      })
      .catch(() => {
        // Ignore cancelled render race on rapid zoom
      });

    return () => {
      cancelled = true;
    };
  }, [renderer, rendererVersion, metrics.pageIndex, scale]);

  const sigByField = useMemo(() => {
    const map = new Map<string, PdfSignatureReport>();
    for (const s of signatures) {
      map.set(s.fieldName, s);
    }
    return map;
  }, [signatures]);

  return (
    <div
      ref={(el) => registerPageEl(metrics.pageIndex, el)}
      data-page-index={metrics.pageIndex}
      className="orb-pdf-page-shell"
      style={{ width: `${width}px`, height: `${height}px` }}
    >
      <canvas ref={canvasRef} />

      <div className="orb-pdf-text-layer" aria-hidden="true">
        {textSpans.map((span, idx) => (
          <span
            key={idx}
            className="orb-pdf-text-span"
            style={{
              left: `${span.left}px`,
              top: `${span.top}px`,
              fontSize: `${Math.max(6, span.fontSize)}px`,
            }}
          >
            {span.text}
          </span>
        ))}
      </div>

      <div className="orb-pdf-form-layer">
        {fields.map((field) => {
          const box = pdfRectToViewport(field.rect, metrics, scale);
          const curVal = formValues[field.name] ?? field.value;
          const dirty = dirtyFields.has(field.name);
          const fontSize = Math.max(10, Math.min(14, Math.round(box.height * 0.54)));

          if (field.fieldType === 'signature') {
            const sig = sigByField.get(field.name) ?? signatures[0] ?? null;
            const invalid = sig ? sig.integrity !== 'valid' : false;
            return (
              <button
                key={field.id}
                type="button"
                className={`orb-pdf-sig-hotspot ${invalid ? 'invalid' : ''}`}
                style={{
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                }}
                title={`Inspect digital signature: ${field.name}`}
                aria-label={`Inspect digital signature ${field.name}`}
                onClick={() => onSelectSignature(sig)}
              />
            );
          }

          if (field.fieldType === 'checkbox') {
            const checked = curVal.kind === 'bool' ? curVal.value : false;
            return (
              <input
                key={field.id}
                id={`pdf-field-${field.name}`}
                type="checkbox"
                className="orb-pdf-field-checkbox"
                checked={checked}
                disabled={field.readOnly}
                aria-label={field.name}
                style={{
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                }}
                onChange={(e) =>
                  onFieldChange(field.name, { kind: 'bool', value: e.target.checked })
                }
              />
            );
          }

          if (field.fieldType === 'radio') {
            const targetState = field.onState ?? 'Yes';
            const selected = curVal.kind === 'choice' && curVal.value === targetState;
            return (
              <input
                key={field.id}
                type="radio"
                name={`pdf-radio-${field.name}`}
                className="orb-pdf-field-radio"
                checked={selected}
                disabled={field.readOnly}
                aria-label={`${field.name}: ${targetState}`}
                style={{
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                }}
                onChange={() =>
                  onFieldChange(field.name, { kind: 'choice', value: targetState })
                }
              />
            );
          }

          if (field.fieldType === 'dropdown' || field.fieldType === 'listbox') {
            const selectedVal = curVal.kind === 'choice' ? curVal.value : '';
            const opts = field.options.includes(selectedVal) || !selectedVal
              ? field.options
              : [selectedVal, ...field.options];
            return (
              <select
                key={field.id}
                id={`pdf-field-${field.name}`}
                className={`orb-pdf-field ${dirty ? 'is-dirty' : ''}`}
                value={selectedVal}
                disabled={field.readOnly}
                aria-label={field.name}
                style={{
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                  fontSize: `${fontSize}px`,
                }}
                onChange={(e) =>
                  onFieldChange(field.name, { kind: 'choice', value: e.target.value })
                }
              >
                {opts.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            );
          }

          if (field.fieldType === 'text') {
            const textVal = curVal.kind === 'text' ? curVal.value : '';
            if (field.multiline) {
              return (
                <textarea
                  key={field.id}
                  id={`pdf-field-${field.name}`}
                  className={`orb-pdf-field orb-pdf-field-textarea ${dirty ? 'is-dirty' : ''}`}
                  value={textVal}
                  readOnly={field.readOnly}
                  maxLength={field.maxLen ?? undefined}
                  aria-label={field.name}
                  style={{
                    left: `${box.left}px`,
                    top: `${box.top}px`,
                    width: `${box.width}px`,
                    height: `${box.height}px`,
                    fontSize: `${Math.max(10, Math.round(11 * scale))}px`,
                  }}
                  onChange={(e) =>
                    onFieldChange(field.name, { kind: 'text', value: e.target.value })
                  }
                />
              );
            }
            return (
              <input
                key={field.id}
                id={`pdf-field-${field.name}`}
                type={field.password ? 'password' : 'text'}
                className={`orb-pdf-field ${dirty ? 'is-dirty' : ''}`}
                value={textVal}
                readOnly={field.readOnly}
                maxLength={field.maxLen ?? undefined}
                aria-label={field.name}
                style={{
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  height: `${box.height}px`,
                  fontSize: `${fontSize}px`,
                }}
                onChange={(e) =>
                  onFieldChange(field.name, { kind: 'text', value: e.target.value })
                }
              />
            );
          }

          return null;
        })}
      </div>

      <span className="orb-pdf-page-num">Page {metrics.pageIndex + 1}</span>
    </div>
  );
};

export const PdfWorkspace: React.FC<PdfWorkspaceProps> = ({
  rawPdf,
  inspection,
  zoom,
  jumpToPageRequest,
  formValues,
  dirtyFields,
  onFieldChange,
  onVisiblePageChange,
  onSelectSignature,
}) => {
  const rendererRef = useRef<PdfPageRenderer | null>(null);
  const [rendererVersion, setRendererVersion] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  if (!rendererRef.current) {
    rendererRef.current = new PdfJsPageRenderer();
  }

  useEffect(() => {
    let cancelled = false;
    const renderer = rendererRef.current!;
    setRenderError(null);
    renderer
      .load(rawPdf)
      .then(() => {
        if (!cancelled) {
          setRendererVersion((v) => v + 1);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rawPdf]);

  useEffect(() => {
    const renderer = rendererRef.current;
    return () => {
      renderer?.destroy().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!jumpToPageRequest) return;
    const el = pageElsRef.current.get(jumpToPageRequest.page);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [jumpToPageRequest]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage: number | null = null;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
            if (!Number.isNaN(idx)) {
              bestPage = idx;
              bestRatio = entry.intersectionRatio;
            }
          }
        }
        if (bestPage !== null) {
          onVisiblePageChange(bestPage);
        }
      },
      { root: container, threshold: [0.25, 0.55, 0.85] },
    );

    for (const el of pageElsRef.current.values()) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [inspection.pages.length, onVisiblePageChange, rendererVersion]);

  const fieldsByPage = useMemo(() => {
    const map = new Map<number, PdfFormField[]>();
    for (const f of inspection.formFields) {
      const list = map.get(f.pageIndex) ?? [];
      list.push(f);
      map.set(f.pageIndex, list);
    }
    return map;
  }, [inspection.formFields]);

  const registerPageEl = (pageIndex: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElsRef.current.set(pageIndex, el);
    } else {
      pageElsRef.current.delete(pageIndex);
    }
  };

  const scale = zoom * 1.15;

  return (
    <>
      {inspection.hasSignatures && dirtyFields.size > 0 && (
        <div className="orb-banner warning" role="status">
          <span>
            Form fields modified on a signed PDF ({dirtyFields.size} edited). Exporting appends a
            PDF incremental update that preserves original signature bytes while marking post-signing
            changes.
          </span>
        </div>
      )}

      {renderError && (
        <div className="orb-banner danger" role="alert">
          <span>PDF renderer error: {renderError}</span>
        </div>
      )}

      <div ref={scrollRef} className="orb-pdf-scroll">
        {rendererVersion > 0 &&
          inspection.pages.map((metrics) => (
            <PdfPageView
              key={`${metrics.pageIndex}-${rendererVersion}`}
              renderer={rendererRef.current!}
              rendererVersion={rendererVersion}
              metrics={metrics}
              scale={scale}
              fields={fieldsByPage.get(metrics.pageIndex) ?? []}
              signatures={inspection.signatures}
              formValues={formValues}
              dirtyFields={dirtyFields}
              onFieldChange={onFieldChange}
              onSelectSignature={onSelectSignature}
              registerPageEl={registerPageEl}
            />
          ))}
      </div>
    </>
  );
};
