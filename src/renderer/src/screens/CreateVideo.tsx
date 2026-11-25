import { useState, useEffect, useRef, useCallback, type DragEvent, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Category } from '@shared/domain';
import type { AspectRatio } from '@shared/provider';
import type { PromptTemplateSummary, RenderedPrompt } from '@shared/prompt';
import type { ProviderStatus, StagedImage } from '@shared/ipc';
import { normalizeSku } from '@shared/domain';
import { getApi } from '../api';
import { en } from '../i18n/en';
import {
  makeTemplateKey,
  findCalendarTemplate,
  findDefaultNonCalendarTemplate,
  pickTemplateForCategory,
  aspectWarning,
  isGenerateEnabled,
  buildCreateJobPayload,
} from './create-video-logic';

export { makeTemplateKey } from './create-video-logic';

interface CreateVideoProps {
  providerStatus: ProviderStatus | null;
  onJobCreated: (jobId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CreateVideo({ providerStatus, onJobCreated }: CreateVideoProps): React.JSX.Element {
  // Front cover image
  const [stagedImage, setStagedImage] = useState<StagedImage | null>(null);
  // Interior artwork (Calendar only)
  const [interiorArtworkStaged, setInteriorArtworkStaged] = useState<StagedImage | null>(null);

  const [rawSku, setRawSku] = useState('');
  const [productName, setProductName] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [templates, setTemplates] = useState<PromptTemplateSummary[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [defaultNonCalendarTemplateKey, setDefaultNonCalendarTemplateKey] = useState('');
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [aspectRatio, setAspectRatio] = useState<string | undefined>(undefined);

  // Prompt preview & override
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [promptOverride, setPromptOverride] = useState('');
  const [overrideBaseline, setOverrideBaseline] = useState<{
    sku: string;
    categoryId: string;
    templateKey: string;
  } | null>(null);
  const [renderedPrompt, setRenderedPrompt] = useState<RenderedPrompt | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Dragging state & errors for front cover
  const [isDragging, setIsDragging] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Dragging state & errors for interior artwork
  const [isDraggingArtwork, setIsDraggingArtwork] = useState(false);
  const [artworkError, setArtworkError] = useState<string | null>(null);

  // Single-flight submission protection & clientRequestId tracking
  const clientRequestIdRef = useRef<string>(crypto.randomUUID());
  const isSubmittingRef = useRef<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // SKU validation
  const normalizedSku = normalizeSku(rawSku);
  const skuError = rawSku.trim().length > 0 && normalizedSku === null ? en.create.form.skuInvalid : null;

  // Selected category & Calendar check
  const selectedCategory = categories.find((c) => c.id === selectedCategoryId);
  const isCalendar = selectedCategory?.promptGroup === 'calendar';

  // Calendar template check
  const calendarTemplate = findCalendarTemplate(templates);
  const isCalendarTemplateMissing = isCalendar && !calendarTemplate;

  // Aspect ratio soft warning check (> 15% difference)
  const showAspectWarning =
    isCalendar &&
    stagedImage !== null &&
    interiorArtworkStaged !== null &&
    aspectWarning(stagedImage.info, interiorArtworkStaged.info);

  // Load categories and templates
  useEffect(() => {
    let active = true;
    const api = getApi();
    void Promise.all([api.catalog.listCategories(), api.prompts.listTemplates()]).then(([catRes, tplRes]) => {
      if (!active) return;
      let firstCat: Category | null = null;
      if (catRes.ok && catRes.data.length > 0) {
        setCategories(catRes.data);
        firstCat = catRes.data[0] ?? null;
        if (firstCat) setSelectedCategoryId(firstCat.id);
      }
      if (tplRes.ok && tplRes.data.length > 0) {
        setTemplates(tplRes.data);
        const defNonCal = findDefaultNonCalendarTemplate(tplRes.data);
        const defNonCalKey = defNonCal ? makeTemplateKey(defNonCal) : '';
        setDefaultNonCalendarTemplateKey(defNonCalKey);

        if (firstCat?.promptGroup === 'calendar') {
          const calTpl = findCalendarTemplate(tplRes.data);
          if (calTpl) {
            setSelectedTemplateKey(makeTemplateKey(calTpl));
          } else {
            setSelectedTemplateKey('');
          }
        } else if (defNonCalKey) {
          setSelectedTemplateKey(defNonCalKey);
        }
      }
    });

    return () => {
      active = false;
    };
  }, []);

  // Compute effective duration & aspect ratio (default from capabilities if not manually selected)
  const supportedDurations = providerStatus?.capabilities?.supportedDurations ?? [];
  const supportedAspectRatios = providerStatus?.capabilities?.supportedAspectRatios ?? [];
  const effectiveDuration = duration ?? (supportedDurations.length > 0 ? supportedDurations[0] : undefined);
  const effectiveAspectRatio = aspectRatio ?? (supportedAspectRatios.length > 0 ? supportedAspectRatios[0] : undefined);

  // Selected template derived from key
  const selectedTemplate = templates.find((t) => makeTemplateKey(t) === selectedTemplateKey);

  // Check if current prompt override was edited against a different SKU, category, or template
  const currentEffectiveSku = normalizedSku || rawSku.trim();
  const isOverrideStale =
    isEditingPrompt &&
    overrideBaseline !== null &&
    (overrideBaseline.sku !== currentEffectiveSku ||
      overrideBaseline.categoryId !== selectedCategoryId ||
      overrideBaseline.templateKey !== selectedTemplateKey);

  // Debounced prompt preview / validation (300ms)
  useEffect(() => {
    const timer = setTimeout(async () => {
      const api = getApi();
      if (isEditingPrompt) {
        // Validate manual override
        try {
          const res = await api.prompts.validate({ text: promptOverride });
          if (res.ok) {
            setRenderedPrompt(res.data);
            setPreviewError(null);
          } else {
            setPreviewError(res.error.message);
          }
        } catch (err) {
          setPreviewError(err instanceof Error ? err.message : en.errors.generic);
        }
      } else {
        // Render from template if template & category are selected
        if (!selectedTemplate || !selectedCategoryId) return;
        try {
          const res = await api.prompts.preview({
            templateId: selectedTemplate.id,
            templateVersion: selectedTemplate.version,
            sku: normalizedSku || (rawSku.trim() || 'SKU-PREVIEW'),
            categoryId: selectedCategoryId,
            productName: productName.trim() || undefined,
            fileName: stagedImage?.fileName,
            durationSeconds: effectiveDuration,
            aspectRatio: effectiveAspectRatio as AspectRatio | undefined,
          });
          if (res.ok) {
            setRenderedPrompt(res.data);
            setPromptOverride(res.data.text);
            setPreviewError(null);
          } else {
            setPreviewError(res.error.message);
          }
        } catch (err) {
          setPreviewError(err instanceof Error ? err.message : en.errors.generic);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [
    isEditingPrompt,
    promptOverride,
    selectedTemplate,
    selectedCategoryId,
    normalizedSku,
    rawSku,
    productName,
    stagedImage?.fileName,
    effectiveDuration,
    effectiveAspectRatio,
  ]);

  // Image drag & drop and browse for Front Cover (or single image)
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const stageSelectedFile = async (file: File) => {
    setImageError(null);
    try {
      const api = getApi();
      const res = await api.images.stageFile(file);
      if (res.ok) {
        setStagedImage(res.data);
      } else {
        setImageError(res.error.message);
      }
    } catch (err) {
      setImageError(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    if (e.dataTransfer.files.length > 1) {
      setImageError(en.create.dropzone.singleFileOnly);
      return;
    }
    const file = e.dataTransfer.files[0];
    if (file) {
      stageSelectedFile(file);
    }
  };

  const handleBrowse = () => {
    setImageError(null);
    const api = getApi();
    api.images
      .pick()
      .then((res) => {
        if (res.ok && res.data) {
          setStagedImage(res.data);
        } else if (!res.ok) {
          setImageError(res.error.message);
        }
      })
      .catch((err) => {
        setImageError(err instanceof Error ? err.message : en.errors.generic);
      });
  };

  const handleDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleBrowse();
    }
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      if (e.target.files.length > 1) {
        setImageError(en.create.dropzone.singleFileOnly);
        return;
      }
      const file = e.target.files[0];
      if (file) {
        stageSelectedFile(file);
      }
    }
  };

  // Interior Artwork handlers (Calendar only)
  const stageArtworkFile = async (file: File) => {
    setArtworkError(null);
    try {
      const api = getApi();
      const res = await api.images.stageFile(file);
      if (res.ok) {
        setInteriorArtworkStaged(res.data);
      } else {
        setArtworkError(res.error.message);
      }
    } catch (err) {
      setArtworkError(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleArtworkBrowse = () => {
    setArtworkError(null);
    const api = getApi();
    api.images
      .pick()
      .then((res) => {
        if (res.ok && res.data) {
          setInteriorArtworkStaged(res.data);
        } else if (!res.ok) {
          setArtworkError(res.error.message);
        }
      })
      .catch((err) => {
        setArtworkError(err instanceof Error ? err.message : en.errors.generic);
      });
  };

  const handleArtworkDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingArtwork(true);
  };

  const handleArtworkDragLeave = () => {
    setIsDraggingArtwork(false);
  };

  const handleArtworkDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingArtwork(false);
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    if (e.dataTransfer.files.length > 1) {
      setArtworkError(en.create.dropzone.singleFileOnly);
      return;
    }
    const file = e.dataTransfer.files[0];
    if (file) {
      stageArtworkFile(file);
    }
  };

  const handleArtworkDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleArtworkBrowse();
    }
  };

  const handleArtworkFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      if (e.target.files.length > 1) {
        setArtworkError(en.create.dropzone.singleFileOnly);
        return;
      }
      const file = e.target.files[0];
      if (file) {
        stageArtworkFile(file);
      }
    }
  };

  // Category change with template auto-select
  const handleCategoryChange = (newCatId: string) => {
    const prevCat = categories.find((c) => c.id === selectedCategoryId);
    const newCat = categories.find((c) => c.id === newCatId);
    setSelectedCategoryId(newCatId);

    const nextTemplateKey = pickTemplateForCategory({
      prevCategory: prevCat,
      newCategory: newCat,
      currentTemplateKey: selectedTemplateKey,
      templates,
      defaultNonCalendarKey: defaultNonCalendarTemplateKey,
    });
    setSelectedTemplateKey(nextTemplateKey);
  };

  // Provider readiness
  const isProviderReady = providerStatus?.mode === 'mock' || providerStatus?.state === 'ready';

  // Quality validation check
  const isQualityPassed = renderedPrompt?.quality?.passed === true;
  const failedQualityChecks = renderedPrompt?.quality?.checks.filter((c) => !c.passed) ?? [];

  // Validation rules for Generate button
  const isFormValid = isGenerateEnabled({
    stagedImage,
    interiorArtworkStaged,
    isCalendar,
    normalizedSku,
    selectedCategoryId,
    selectedTemplateKey,
    renderedPrompt,
    isQualityPassed,
    isProviderReady,
    isSubmitting,
  });

  const handleStartEditing = () => {
    setIsEditingPrompt(true);
    setOverrideBaseline({
      sku: currentEffectiveSku,
      categoryId: selectedCategoryId,
      templateKey: selectedTemplateKey,
    });
  };

  const handleResetToTemplate = () => {
    setIsEditingPrompt(false);
    setPromptOverride('');
    setOverrideBaseline(null);
  };

  const handleGenerate = useCallback(async () => {
    // Single-flight check: ref checked immediately before state update
    if (isSubmittingRef.current) {
      return;
    }
    if (!isFormValid || !stagedImage || !normalizedSku || !selectedTemplate) {
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    const clientRequestId = clientRequestIdRef.current;

    const payload = buildCreateJobPayload({
      clientRequestId,
      stagedImage,
      interiorArtworkStaged,
      isCalendar,
      normalizedSku,
      selectedCategoryId,
      templateId: selectedTemplate.id,
      templateVersion: selectedTemplate.version,
      productName: productName.trim() || undefined,
      promptOverride: isEditingPrompt ? promptOverride : undefined,
      durationSeconds: effectiveDuration,
      aspectRatio: effectiveAspectRatio as AspectRatio | undefined,
    });

    try {
      const api = getApi();
      const res = await api.jobs.create(payload);

      if (res.ok) {
        // RESET clientRequestIdRef to a new UUID ONLY after a successful create!
        clientRequestIdRef.current = crypto.randomUUID();
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        onJobCreated(res.data.job.id);
      } else {
        // KEEP the same id after a failed create for safe idempotent retry
        setSubmitError(res.error.message);
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    } catch (err) {
      // KEEP the same id after an error
      setSubmitError(err instanceof Error ? err.message : en.errors.generic);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    isFormValid,
    stagedImage,
    interiorArtworkStaged,
    isCalendar,
    normalizedSku,
    selectedTemplate,
    selectedCategoryId,
    productName,
    isEditingPrompt,
    promptOverride,
    effectiveDuration,
    effectiveAspectRatio,
    onJobCreated,
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{en.create.title}</h2>
        <p className="info-text">{en.create.subtitle}</p>
      </div>

      {!isProviderReady && (
        <div className="card" style={{ backgroundColor: 'var(--warning-bg)', borderColor: 'var(--warning)' }}>
          <p style={{ color: '#92400e', fontWeight: 600, fontSize: '0.875rem' }}>{en.create.notReadyNotice}</p>
        </div>
      )}

      {/* Calendar template missing notification */}
      {isCalendarTemplateMissing && (
        <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
          <p className="error-text">{en.create.dropzone.calendarTemplateMissing}</p>
        </div>
      )}

      {/* Soft aspect-ratio mismatch warning */}
      {showAspectWarning && (
        <div className="card" style={{ backgroundColor: 'var(--warning-bg)', borderColor: 'var(--warning)' }}>
          <p style={{ color: '#92400e', fontWeight: 600, fontSize: '0.875rem' }}>
            {en.create.dropzone.aspectRatioWarning}
          </p>
        </div>
      )}

      {submitError && (
        <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
          <p className="error-text">{submitError}</p>
        </div>
      )}

      <div className="create-grid">
        {/* Left Column: Image upload(s) & Product details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Calendar dual dropzones vs Apparel single dropzone */}
          {isCalendar ? (
            <>
              {/* Dropzone 1: Front Cover */}
              <div className="card">
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                  {en.create.dropzone.frontCoverTitle}
                </h3>
                {!stagedImage ? (
                  <div
                    className={`dropzone-container ${isDragging ? 'dragging' : ''}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={handleBrowse}
                    onKeyDown={handleDropzoneKeyDown}
                    role="button"
                    tabIndex={0}
                    aria-label="Upload front cover image dropzone"
                  >
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🖼️</div>
                    <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                      {en.create.dropzone.frontCoverPrompt}
                    </p>
                    <p className="info-text" style={{ marginBottom: '1rem' }}>
                      {en.create.dropzone.acceptHint}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBrowse();
                      }}
                    >
                      {en.create.dropzone.browse}
                    </button>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      onChange={handleFileInputChange}
                      aria-hidden="true"
                    />
                  </div>
                ) : (
                  <div className="dropzone-preview">
                    <img
                      src={stagedImage.previewUrl}
                      alt={`Preview of ${stagedImage.fileName}`}
                      style={{ width: '100%', height: 'auto', maxHeight: '240px', objectFit: 'contain' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{stagedImage.fileName}</div>
                        <span className="info-text">
                          {en.create.dropzone.imageInfo
                            .replace('{mime}', stagedImage.info.mime)
                            .replace('{width}', String(stagedImage.info.width))
                            .replace('{height}', String(stagedImage.info.height))
                            .replace('{size}', formatBytes(stagedImage.info.bytes))}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={handleBrowse}
                        >
                          {en.create.dropzone.replaceImage}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => setStagedImage(null)}
                        >
                          {en.create.dropzone.clearImage}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {imageError && <p className="error-text" style={{ marginTop: '0.5rem' }}>{imageError}</p>}
              </div>

              {/* Dropzone 2: Interior Artwork */}
              <div className="card">
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                  {en.create.dropzone.interiorArtworkTitle}
                </h3>
                {!interiorArtworkStaged ? (
                  <div
                    className={`dropzone-container ${isDraggingArtwork ? 'dragging' : ''}`}
                    onDragOver={handleArtworkDragOver}
                    onDragLeave={handleArtworkDragLeave}
                    onDrop={handleArtworkDrop}
                    onClick={handleArtworkBrowse}
                    onKeyDown={handleArtworkDropzoneKeyDown}
                    role="button"
                    tabIndex={0}
                    aria-label="Upload interior artwork image dropzone"
                  >
                    <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📄</div>
                    <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                      {en.create.dropzone.interiorArtworkPrompt}
                    </p>
                    <p className="info-text" style={{ marginBottom: '0.5rem' }}>
                      {en.create.dropzone.acceptHint}
                    </p>
                    <p className="info-text" style={{ marginBottom: '1rem', color: 'var(--primary)' }}>
                      {en.create.dropzone.artworkRequiredNotice}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleArtworkBrowse();
                      }}
                    >
                      {en.create.dropzone.browse}
                    </button>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      onChange={handleArtworkFileInputChange}
                      aria-hidden="true"
                    />
                  </div>
                ) : (
                  <div className="dropzone-preview">
                    <img
                      src={interiorArtworkStaged.previewUrl}
                      alt={`Preview of ${interiorArtworkStaged.fileName}`}
                      style={{ width: '100%', height: 'auto', maxHeight: '240px', objectFit: 'contain' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{interiorArtworkStaged.fileName}</div>
                        <span className="info-text">
                          {en.create.dropzone.imageInfo
                            .replace('{mime}', interiorArtworkStaged.info.mime)
                            .replace('{width}', String(interiorArtworkStaged.info.width))
                            .replace('{height}', String(interiorArtworkStaged.info.height))
                            .replace('{size}', formatBytes(interiorArtworkStaged.info.bytes))}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={handleArtworkBrowse}
                        >
                          {en.create.dropzone.replaceArtwork}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => setInteriorArtworkStaged(null)}
                        >
                          {en.create.dropzone.removeArtwork}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {artworkError && <p className="error-text" style={{ marginTop: '0.5rem' }}>{artworkError}</p>}
              </div>
            </>
          ) : (
            /* Single dropzone for apparel / other categories (existing unchanged) */
            <div className="card">
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Product Mockup</h3>
              {!stagedImage ? (
                <div
                  className={`dropzone-container ${isDragging ? 'dragging' : ''}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={handleBrowse}
                  onKeyDown={handleDropzoneKeyDown}
                  role="button"
                  tabIndex={0}
                  aria-label="Upload mockup image dropzone"
                >
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🖼️</div>
                  <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{en.create.dropzone.prompt}</p>
                  <p className="info-text" style={{ marginBottom: '1rem' }}>
                    {en.create.dropzone.acceptHint}
                  </p>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBrowse();
                    }}
                  >
                    {en.create.dropzone.browse}
                  </button>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                    aria-hidden="true"
                  />
                </div>
              ) : (
                <div className="dropzone-preview">
                  <img
                    src={stagedImage.previewUrl}
                    alt={`Preview of ${stagedImage.fileName}`}
                    style={{ width: '100%', height: 'auto', maxHeight: '240px', objectFit: 'contain' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{stagedImage.fileName}</div>
                      <span className="info-text">
                        {en.create.dropzone.imageInfo
                          .replace('{mime}', stagedImage.info.mime)
                          .replace('{width}', String(stagedImage.info.width))
                          .replace('{height}', String(stagedImage.info.height))
                          .replace('{size}', formatBytes(stagedImage.info.bytes))}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setStagedImage(null)}
                    >
                      {en.create.dropzone.clearImage}
                    </button>
                  </div>
                </div>
              )}
              {imageError && <p className="error-text" style={{ marginTop: '0.5rem' }}>{imageError}</p>}
            </div>
          )}

          {/* Form inputs */}
          <div className="card">
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Product Information</h3>

            {/* SKU Input */}
            <div className="form-group">
              <label htmlFor="sku-input">{en.create.form.sku} *</label>
              <input
                id="sku-input"
                type="text"
                placeholder={en.create.form.skuPlaceholder}
                value={rawSku}
                onChange={(e) => setRawSku(e.target.value)}
                aria-invalid={skuError !== null}
              />
              {normalizedSku && (
                <span className="info-text" style={{ color: 'var(--success)' }}>
                  {en.create.form.skuNormalized.replace('{sku}', normalizedSku)}
                </span>
              )}
              {skuError && <span className="error-text">{skuError}</span>}
            </div>

            {/* Product Name Input */}
            <div className="form-group">
              <label htmlFor="product-name-input">{en.create.form.productName}</label>
              <input
                id="product-name-input"
                type="text"
                placeholder={en.create.form.productNamePlaceholder}
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
              />
            </div>

            {/* Category Select */}
            <div className="form-group">
              <label htmlFor="category-select">{en.create.form.category} *</label>
              <select
                id="category-select"
                value={selectedCategoryId}
                onChange={(e) => handleCategoryChange(e.target.value)}
              >
                <option value="">{en.create.form.selectCategory}</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label} ({cat.promptGroup})
                  </option>
                ))}
              </select>
            </div>

            {/* Template Select Keyed by id@@version */}
            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <label htmlFor="template-select">{en.create.form.template} *</label>
                {selectedTemplate?.isPlaceholder && (
                  <span className="badge-placeholder" title={en.create.form.templatePlaceholderWarning}>
                    {en.create.form.templatePlaceholderBadge}
                  </span>
                )}
              </div>
              <select
                id="template-select"
                value={selectedTemplateKey}
                onChange={(e) => setSelectedTemplateKey(e.target.value)}
              >
                <option value="">{en.create.form.selectTemplate}</option>
                {templates.map((tpl) => (
                  <option key={makeTemplateKey(tpl)} value={makeTemplateKey(tpl)}>
                    {tpl.title} — {tpl.version}
                    {tpl.isPlaceholder ? ' [PLACEHOLDER]' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Duration and Aspect Selects (shown ONLY if capabilities are provided) */}
            {(supportedDurations.length > 0 || supportedAspectRatios.length > 0) && (
              <div className="form-row">
                {supportedDurations.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="duration-select">{en.create.form.duration}</label>
                    <select
                      id="duration-select"
                      value={effectiveDuration ?? ''}
                      onChange={(e) => setDuration(Number(e.target.value))}
                    >
                      {supportedDurations.map((dur) => (
                        <option key={dur} value={dur}>
                          {en.create.form.seconds.replace('{sec}', String(dur))}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {supportedAspectRatios.length > 0 && (
                  <div className="form-group">
                    <label htmlFor="aspect-select">{en.create.form.aspectRatio}</label>
                    <select
                      id="aspect-select"
                      value={effectiveAspectRatio ?? ''}
                      onChange={(e) => setAspectRatio(e.target.value)}
                    >
                      {supportedAspectRatios.map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Prompt preview, checklist & Generate button */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="card prompt-preview-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{en.create.promptPreview.title}</h3>
                {renderedPrompt && (
                  <span className="info-text">
                    {en.create.promptPreview.templateInfo
                      .replace('{id}', renderedPrompt.templateId)
                      .replace('{version}', renderedPrompt.templateVersion)}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {isEditingPrompt ? (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setIsEditingPrompt(false);
                      if (renderedPrompt) setPromptOverride(renderedPrompt.text);
                    }}
                  >
                    {en.create.promptPreview.cancelEdit}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={handleStartEditing}
                  >
                    {en.create.promptPreview.editPrompt}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleResetToTemplate}
                >
                  {en.create.promptPreview.resetPrompt}
                </button>
              </div>
            </div>

            {/* Stale prompt override warning */}
            {isOverrideStale && (
              <div
                style={{
                  backgroundColor: 'var(--warning-bg)',
                  border: '1px solid var(--warning)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.75rem',
                }}
              >
                <p style={{ color: '#92400e', fontSize: '0.8125rem', marginBottom: '0.4rem' }}>
                  {en.create.promptPreview.staleOverrideWarning}
                </p>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleResetToTemplate}
                >
                  {en.create.promptPreview.resetPrompt}
                </button>
              </div>
            )}

            {/* Prompt preview or editor */}
            {isEditingPrompt ? (
              <textarea
                rows={6}
                value={promptOverride}
                onChange={(e) => setPromptOverride(e.target.value)}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8125rem', padding: '0.5rem' }}
                aria-label="Editable prompt text"
              />
            ) : (
              <div className="prompt-box" role="region" aria-label="Prompt text preview">
                {renderedPrompt ? renderedPrompt.text : en.app.loading}
              </div>
            )}

            {previewError && <p className="error-text">{previewError}</p>}

            {/* Character count */}
            {renderedPrompt && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    color: renderedPrompt.chars > renderedPrompt.maxChars ? 'var(--danger)' : 'var(--text-muted)',
                  }}
                >
                  {en.create.promptPreview.charCount
                    .replace('{current}', String(renderedPrompt.chars))
                    .replace('{max}', String(renderedPrompt.maxChars))}
                </span>
              </div>
            )}

            {/* Validation errors */}
            {renderedPrompt && renderedPrompt.errors.length > 0 && (
              <div style={{ backgroundColor: 'var(--danger-bg)', padding: '0.75rem', borderRadius: 'var(--radius-md)' }}>
                <strong style={{ fontSize: '0.8125rem', color: 'var(--danger)' }}>
                  {en.create.promptPreview.validationErrors}
                </strong>
                <ul style={{ paddingLeft: '1.25rem', marginTop: '0.25rem', fontSize: '0.8125rem', color: 'var(--danger)' }}>
                  {renderedPrompt.errors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Quality Checklist */}
            {renderedPrompt && (
              <div>
                <h4 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                  {en.create.promptPreview.checklistTitle}
                </h4>
                <div className="quality-checklist">
                  {renderedPrompt.quality.checks.map((chk) => (
                    <div
                      key={chk.rule}
                      className={`quality-item ${chk.passed ? 'passed' : 'failed'}`}
                      title={chk.label}
                    >
                      <span>{chk.passed ? '✓' : '✗'}</span>
                      <span>{chk.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Failed quality checks notice next to button */}
            {!isQualityPassed && renderedPrompt && failedQualityChecks.length > 0 && (
              <div
                style={{
                  backgroundColor: 'var(--danger-bg)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.8125rem',
                  color: 'var(--danger)',
                }}
              >
                <span>Generation blocked — quality checks failed: </span>
                <strong>{failedQualityChecks.map((c) => c.label).join(', ')}</strong>
              </div>
            )}

            {/* Main Action: Generate video */}
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn-primary"
                style={{ width: '100%', padding: '0.75rem', fontSize: '1rem', fontWeight: 600 }}
                disabled={!isFormValid || isSubmitting}
                onClick={handleGenerate}
              >
                {isSubmitting ? en.create.generatingButton : en.create.generateButton}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
