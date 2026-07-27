"use client";
import * as React from "react";
import JSZip from "jszip";
import { toPng } from "html-to-image";
import { Toaster, toast } from "sonner";
import {
  DEVICE_LABEL,
  getExportSizes,
  hasTheme,
  supportsLandscape,
  themeById,
} from "@/lib/constants";
import { detectPlatform, nid } from "@/lib/defaults";
import { isBuiltInElementId, isTextElementId, textElementKey } from "@/lib/elements";
import { preloadImages } from "@/lib/image-cache";
import { resolveScreenshot, writeLocalized } from "@/lib/locale";
import { mergeWithDefaults, useProject } from "@/lib/storage";
import type {
  BuiltInElementId,
  Device,
  ElementId,
  ElementTransform,
  SelectedElement,
  Slide,
  SlideBackgroundConfig,
} from "@/lib/types";
import { Inspector } from "./inspector";
import { PreviewStage } from "./preview-stage";
import { Sidebar } from "./sidebar";
import { DeckCanvas, getCanvas } from "./slide-canvas";
import { Toolbar } from "./toolbar";

export function ScreenshotEditor() {
  const { state, setState, hydrated, savedAt, saveError, reset, resetDevice, undo, redo } = useProject();
  const [activeSlideId, setActiveSlideId] = React.useState<string | null>(null);
  const [selectedElement, setSelectedElement] = React.useState<SelectedElement | null>(null);
  const [exporting, setExporting] = React.useState<string | null>(null);
  const [exportDeviceOverride, setExportDeviceOverride] = React.useState<Device | null>(null);
  const [exportLocaleOverride, setExportLocaleOverride] = React.useState<string | null>(null);
  const [exportSlideIndex, setExportSlideIndex] = React.useState(0);
  const exportRef = React.useRef<HTMLDivElement | null>(null);

  const currentSlides = state.slidesByDevice[state.device] || [];
  const activeSlide =
    currentSlides.find((s) => s.id === activeSlideId) || currentSlides[0] || null;
  const theme = themeById(state.themeId);

  const activeExportDevice = exportDeviceOverride ?? state.device;
  const activeExportSlides = state.slidesByDevice[activeExportDevice] || [];
  const { cW: exportCW, cH: exportCH } = getCanvas(activeExportDevice, state.orientation);

  React.useEffect(() => {
    if (selectedElement && selectedElement.slideId !== activeSlide?.id) {
      setSelectedElement(null);
    }
  }, [activeSlide?.id, selectedElement]);

  React.useEffect(() => {
    if (!hydrated) return;
    if (!activeSlide && currentSlides.length > 0) {
      setActiveSlideId(currentSlides[0].id);
    }
  }, [hydrated, currentSlides, activeSlide]);

  React.useEffect(() => {
    if (!supportsLandscape(state.device) && state.orientation !== "portrait") {
      setState((p) => ({ ...p, orientation: "portrait" }));
    }
  }, [state.device, state.orientation, setState]);

  React.useEffect(() => {
    if (hydrated && state.themeId && !hasTheme(state.themeId)) {
      toast.warning("Using fallback theme", {
        description: `Theme "${state.themeId}" is not defined in src/lib/constants.ts.`,
        duration: 8000,
      });
    }
  }, [hydrated, state.themeId]);

  const assetPaths = React.useMemo(() => {
    const paths = new Set<string>();
    paths.add("/mockup.png");
    if (state.appIcon) paths.add(state.appIcon);
    // Preload every locale variant so bulk export doesn't race image loads.
    const allSlides: Slide[] = Object.values(state.slidesByDevice).flat();
    for (const s of allSlides) {
      for (const raw of [s.screenshot, s.screenshotSecondary]) {
        if (!raw || raw.startsWith("data:")) continue;
        if (raw.includes("{locale}")) {
          for (const loc of state.locales) paths.add(resolveScreenshot(raw, loc));
        } else {
          paths.add(raw);
        }
      }
    }
    return Array.from(paths).sort();
  }, [state.slidesByDevice, state.appIcon, state.locales]);
  const assetSig = assetPaths.join("|");

  React.useEffect(() => {
    if (!hydrated) return;
    void preloadImages(assetPaths);
    // assetPaths is derived from assetSig; depending on the string keeps the
    // effect from re-firing when slidesByDevice churns without path changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, assetSig]);

  // Surface storage failures (quota exceeded etc.) so the user knows their work isn't safe.
  React.useEffect(() => {
    if (saveError) {
      toast.error("Couldn't load or save project file", {
        description: saveError,
        duration: 8000,
      });
    }
  }, [saveError]);

  // ---------- Mutations ----------

  // ---------- Synchronized Mutations ----------

  const patchSlideWithSync = React.useCallback(
    (slideId: string, patch: Partial<Slide>) => {
      setState((prev) => {
        const currentDev = prev.device;

        if (currentDev === "default") {
          // 1. Update slide on default device
          const defaultSlides = (prev.slidesByDevice.default || []).map((slide) => {
            if (slide.id !== slideId) return slide;
            return { ...slide, ...patch };
          });

          // 2. Sync non-overridden fields to all other devices
          const patchKeys = Object.keys(patch) as (keyof Slide)[];
          const newSlidesByDevice = { ...prev.slidesByDevice, default: defaultSlides };

          const ALL_OTHER_DEVICES: Device[] = [
            "iphone",
            "ipad",
            "android",
            "android-7",
            "android-10",
            "feature-graphic",
          ];

          for (const dev of ALL_OTHER_DEVICES) {
            const devSlides = prev.slidesByDevice[dev];
            if (!devSlides) continue;

            newSlidesByDevice[dev] = devSlides.map((slide) => {
              if (slide.id !== slideId) return slide;

              const syncPatch: Partial<Slide> = {};
              for (const key of patchKeys) {
                if (!slide.overrides?.[key]) {
                  (syncPatch as any)[key] = patch[key];
                }
              }

              if (Object.keys(syncPatch).length === 0) return slide;
              return { ...slide, ...syncPatch };
            });
          }

          return {
            ...prev,
            slidesByDevice: newSlidesByDevice,
          };
        } else {
          // Editing on a specific non-default device
          const patchKeys = Object.keys(patch);
          const overridesPatch: Record<string, boolean> = {};
          for (const k of patchKeys) {
            if (k !== "id" && k !== "overrides") {
              overridesPatch[k] = true;
            }
          }

          const curSlides = prev.slidesByDevice[currentDev] || [];
          const nextSlides = curSlides.map((slide) => {
            if (slide.id !== slideId) return slide;
            return {
              ...slide,
              ...patch,
              overrides: {
                ...(slide.overrides || {}),
                ...overridesPatch,
              },
            };
          });

          return {
            ...prev,
            slidesByDevice: {
              ...prev.slidesByDevice,
              [currentDev]: nextSlides,
            },
          };
        }
      });
    },
    [setState],
  );

  const patchSlide = React.useCallback(
    (id: string, patch: Partial<Slide>) => {
      patchSlideWithSync(id, patch);
    },
    [patchSlideWithSync],
  );

  const reorderSlides = React.useCallback(
    (next: Slide[]) => {
      setState((prev) => {
        if (prev.device === "default") {
          const nextIds = next.map((s) => s.id);
          const newSlidesByDevice = { ...prev.slidesByDevice, default: next };
          const ALL_OTHER_DEVICES: Device[] = [
            "iphone",
            "ipad",
            "android",
            "android-7",
            "android-10",
            "feature-graphic",
          ];
          for (const d of ALL_OTHER_DEVICES) {
            const cur = prev.slidesByDevice[d] || [];
            const sorted = [...cur].sort((a, b) => {
              const indexA = nextIds.indexOf(a.id);
              const indexB = nextIds.indexOf(b.id);
              if (indexA !== -1 && indexB !== -1) return indexA - indexB;
              if (indexA !== -1) return -1;
              if (indexB !== -1) return 1;
              return 0;
            });
            newSlidesByDevice[d] = sorted;
          }
          return { ...prev, slidesByDevice: newSlidesByDevice };
        } else {
          return {
            ...prev,
            slidesByDevice: { ...prev.slidesByDevice, [prev.device]: next },
          };
        }
      });
    },
    [setState],
  );

  const deleteSlide = React.useCallback(
    (id: string) => {
      const dev = state.device;
      const slides = state.slidesByDevice[dev] || [];
      const idx = slides.findIndex((s) => s.id === id);
      if (idx === -1) return;
      const snap = slides[idx];
      const fallback = slides[idx + 1] || slides[idx - 1] || null;

      setState((prev) => {
        if (prev.device === "default") {
          const ALL_DEVICES: Device[] = [
            "default",
            "iphone",
            "ipad",
            "android",
            "android-7",
            "android-10",
            "feature-graphic",
          ];
          const nextSlidesByDevice = { ...prev.slidesByDevice };
          for (const d of ALL_DEVICES) {
            nextSlidesByDevice[d] = (nextSlidesByDevice[d] || []).filter((s) => s.id !== id);
          }
          return {
            ...prev,
            slidesByDevice: nextSlidesByDevice,
          };
        } else {
          const cur = prev.slidesByDevice[dev] || [];
          return {
            ...prev,
            slidesByDevice: { ...prev.slidesByDevice, [dev]: cur.filter((s) => s.id !== id) },
          };
        }
      });
      setActiveSlideId((cur) => (cur === id ? fallback?.id || null : cur));

      toast("Screen deleted", {
        action: {
          label: "Undo",
          onClick: () => {
            setState((prev) => {
              const cur = prev.slidesByDevice[dev] || [];
              if (cur.some((s) => s.id === snap.id)) return prev;
              const restored = [...cur.slice(0, idx), snap, ...cur.slice(idx)];
              return {
                ...prev,
                slidesByDevice: { ...prev.slidesByDevice, [dev]: restored },
              };
            });
            setActiveSlideId(snap.id);
          },
        },
        duration: 6000,
      });
    },
    [setState, state.device, state.slidesByDevice],
  );

  const addSlide = React.useCallback(
    (slide: Slide) => {
      setState((prev) => {
        if (prev.device === "default") {
          const ALL_DEVICES: Device[] = [
            "default",
            "iphone",
            "ipad",
            "android",
            "android-7",
            "android-10",
            "feature-graphic",
          ];
          const nextSlidesByDevice = { ...prev.slidesByDevice };
          for (const d of ALL_DEVICES) {
            const cur = nextSlidesByDevice[d] || [];
            nextSlidesByDevice[d] = [...cur, { ...slide }];
          }
          return {
            ...prev,
            slidesByDevice: nextSlidesByDevice,
          };
        } else {
          return {
            ...prev,
            slidesByDevice: {
              ...prev.slidesByDevice,
              [prev.device]: [...(prev.slidesByDevice[prev.device] || []), slide],
            },
          };
        }
      });
      setActiveSlideId(slide.id);
    },
    [setState],
  );

  const patchLocalized = React.useCallback(
    (slide: Slide, key: "label" | "headline", value: string) => {
      patchSlideWithSync(slide.id, {
        [key]: writeLocalized(slide[key], state.locale, value),
      } as Partial<Slide>);
    },
    [patchSlideWithSync, state.locale],
  );

  const patchElementTransform = React.useCallback(
    (slideId: string, elementId: ElementId, transform: ElementTransform) => {
      const activeSlides = state.slidesByDevice[state.device] || [];
      const targetSlide = activeSlides.find((s) => s.id === slideId);
      if (!targetSlide) return;

      if (isTextElementId(elementId)) {
        const textId = textElementKey(elementId);
        const updatedTextElements = (targetSlide.textElements || []).map((element) =>
          element.id === textId ? { ...element, transform } : element,
        );
        patchSlideWithSync(slideId, { textElements: updatedTextElements });
      } else if (isBuiltInElementId(elementId)) {
        const updatedTransforms = {
          ...(targetSlide.transforms || {}),
          [elementId]: transform,
        } as Partial<Record<BuiltInElementId, ElementTransform>>;
        patchSlideWithSync(slideId, { transforms: updatedTransforms });
      }
    },
    [state.slidesByDevice, state.device, patchSlideWithSync],
  );

  const patchTextElementText = React.useCallback(
    (slideId: string, textId: string, value: string) => {
      const activeSlides = state.slidesByDevice[state.device] || [];
      const targetSlide = activeSlides.find((s) => s.id === slideId);
      if (!targetSlide) return;

      const updatedTextElements = (targetSlide.textElements || []).map((element) =>
        element.id === textId
          ? { ...element, text: writeLocalized(element.text, state.locale, value) }
          : element,
      );
      patchSlideWithSync(slideId, { textElements: updatedTextElements });
    },
    [state.slidesByDevice, state.device, state.locale, patchSlideWithSync],
  );

  const applyBackgroundToAll = React.useCallback(
    (bgConfig: SlideBackgroundConfig | undefined, inverted?: boolean) => {
      setState((prev) => {
        const currentDev = prev.device;
        if (currentDev === "default") {
          const defaultSlides = (prev.slidesByDevice.default || []).map((slide) => ({
            ...slide,
            background: bgConfig ? { ...bgConfig } : undefined,
            ...(inverted !== undefined ? { inverted } : {}),
          }));

          const newSlidesByDevice = { ...prev.slidesByDevice, default: defaultSlides };
          const ALL_OTHER_DEVICES: Device[] = [
            "iphone",
            "ipad",
            "android",
            "android-7",
            "android-10",
            "feature-graphic",
          ];

          for (const dev of ALL_OTHER_DEVICES) {
            const devSlides = prev.slidesByDevice[dev];
            if (!devSlides) continue;

            newSlidesByDevice[dev] = devSlides.map((slide) => {
              const bgOverridden = slide.overrides?.background;
              const invOverridden = slide.overrides?.inverted;
              const nextBackground = !bgOverridden
                ? (bgConfig ? { ...bgConfig } : undefined)
                : slide.background;
              const nextInverted = !invOverridden && inverted !== undefined
                ? inverted
                : slide.inverted;

              return {
                ...slide,
                background: nextBackground,
                inverted: nextInverted,
              };
            });
          }

          return { ...prev, slidesByDevice: newSlidesByDevice };
        } else {
          const curSlides = prev.slidesByDevice[currentDev] || [];
          const nextSlides = curSlides.map((slide) => ({
            ...slide,
            background: bgConfig ? { ...bgConfig } : undefined,
            ...(inverted !== undefined ? { inverted } : {}),
            overrides: {
              ...(slide.overrides || {}),
              background: true,
              ...(inverted !== undefined ? { inverted: true } : {}),
            },
          }));
          return {
            ...prev,
            slidesByDevice: {
              ...prev.slidesByDevice,
              [currentDev]: nextSlides,
            },
          };
        }
      });
      toast.success("Background applied to all screens");
    },
    [setState],
  );

  const resetSlideToDefault = React.useCallback(
    (slideId: string) => {
      setState((prev) => {
        const currentDev = prev.device;
        if (currentDev === "default") return prev;

        const defaultSlide = (prev.slidesByDevice.default || []).find((s) => s.id === slideId);
        if (!defaultSlide) return prev;

        const curSlides = prev.slidesByDevice[currentDev] || [];
        const nextSlides = curSlides.map((slide) => {
          if (slide.id !== slideId) return slide;
          return {
            ...defaultSlide,
            overrides: undefined,
          };
        });

        return {
          ...prev,
          slidesByDevice: {
            ...prev.slidesByDevice,
            [currentDev]: nextSlides,
          },
        };
      });
      toast.success("Default cihazındaki değerlerle senkronize edildi");
    },
    [setState],
  );

  const handleSaveProject = React.useCallback(() => {
    try {
      const jsonStr = JSON.stringify(state, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const fileName = `${(state.appName || "project").toLowerCase().replace(/[^a-z0-9_-]+/gi, "-")}-project.json`;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Project file saved: ${fileName}`);
    } catch {
      toast.error("Failed to save project file");
    }
  }, [state]);

  const handleOpenProject = React.useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string;
          const parsed = JSON.parse(content);
          if (!parsed || typeof parsed !== "object" || !parsed.slidesByDevice) {
            toast.error("Invalid project file structure (.json expected)");
            return;
          }
          const merged = mergeWithDefaults(parsed);
          setState(merged);
          setActiveSlideId(null);
          toast.success("Project loaded successfully!");
        } catch {
          toast.error("Could not parse JSON project file");
        }
      };
      reader.onerror = () => {
        toast.error("Failed to read project file");
      };
      reader.readAsText(file);
    },
    [setState],
  );

  const duplicateSlide = React.useCallback(
    (id: string) => {
      let newId: string | null = null;
      setState((prev) => {
        const slides = prev.slidesByDevice[prev.device] || [];
        const idx = slides.findIndex((s) => s.id === id);
        if (idx === -1) return prev;
        const src = slides[idx];
        newId = nid();
        const copy: Slide = {
          ...src,
          id: newId,
          label: { ...src.label },
          headline: { ...src.headline },
          transforms: src.transforms
            ? Object.fromEntries(
              Object.entries(src.transforms).map(([key, value]) => [key, { ...value }]),
            )
            : undefined,
          textElements: src.textElements?.map((element) => ({
            ...element,
            id: nid(),
            text: { ...element.text },
            transform: { ...element.transform },
          })),
        };
        const next = [...slides.slice(0, idx + 1), copy, ...slides.slice(idx + 1)];
        return {
          ...prev,
          slidesByDevice: { ...prev.slidesByDevice, [prev.device]: next },
        };
      });
      if (newId) setActiveSlideId(newId);
    },
    [setState],
  );

  // ---------- Keyboard shortcuts ----------

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          (target as HTMLElement).isContentEditable);
      if (exporting) return;

      if (e.key === "Escape") {
        setSelectedElement(null);
        if (target && "blur" in target && typeof target.blur === "function") target.blur();
        return;
      }

      // Let focused inputs and contenteditable text keep their native undo,
      // redo, selection, and deletion behavior.
      if (inEditable) return;

      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }
      if (!currentSlides.length) return;
      const idx = activeSlide ? currentSlides.findIndex((s) => s.id === activeSlide.id) : -1;
      if (e.key === "ArrowDown" || (e.key === "j" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        const next = currentSlides[Math.min(currentSlides.length - 1, idx + 1)];
        if (next) setActiveSlideId(next.id);
      } else if (e.key === "ArrowUp" || (e.key === "k" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        const next = currentSlides[Math.max(0, idx - 1)];
        if (next) setActiveSlideId(next.id);
      } else if ((e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey)) {
        if (activeSlide) {
          e.preventDefault();
          duplicateSlide(activeSlide.id);
        }
      } else if ((e.key === "Backspace" || e.key === "Delete") && (e.metaKey || e.ctrlKey)) {
        if (activeSlide) {
          e.preventDefault();
          deleteSlide(activeSlide.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSlide, currentSlides, duplicateSlide, deleteSlide, exporting, undo, redo]);

  // ---------- Export ----------

  // Wait two animation frames so React's render → browser layout/paint of the
  // off-screen container settles before html-to-image snapshots it. One frame
  // is occasionally not enough on slower machines.
  const waitForPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  async function exportAll() {
    const ALL_DEVICES: Device[] = [
      "iphone",
      "ipad",
      "android",
      "android-7",
      "android-10",
      "feature-graphic",
    ];

    const configuredDevices = ALL_DEVICES.filter(
      (dev) => (state.slidesByDevice[dev] || []).length > 0
    );

    if (!configuredDevices.length) {
      toast.error("No screens to export");
      return;
    }

    const locales = state.locales;
    await preloadImages(assetPaths, { retryFailed: true });
    await waitForPaint();

    let totalUnits = 0;
    for (const dev of configuredDevices) {
      const slides = state.slidesByDevice[dev] || [];
      const sizes = getExportSizes(dev, state.orientation);
      totalUnits += sizes.length * locales.length * slides.length;
    }

    if (totalUnits === 0) {
      toast.error("Nothing to export");
      return;
    }

    // Make sure custom fonts are loaded before snapshot
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
    }

    const zip = new JSZip();
    let currentUnit = 0;
    let okCount = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const dev of configuredDevices) {
      const slides = state.slidesByDevice[dev] || [];
      const sizes = getExportSizes(dev, state.orientation);
      const platform = detectPlatform(dev);
      const deviceFolder = DEVICE_LABEL[dev] || dev;

      setExportDeviceOverride(dev);
      await waitForPaint();

      for (const locale of locales) {
        setExportLocaleOverride(locale);
        await waitForPaint();

        for (const size of sizes) {
          for (let i = 0; i < slides.length; i++) {
            const slide = slides[i];
            currentUnit += 1;
            setExporting(`${currentUnit}/${totalUnits}`);
            setExportSlideIndex(i);
            await waitForPaint();

            const el = exportRef.current;
            if (!el) {
              failed += 1;
              errors.push(`${dev} ${locale} ${size.w}×${size.h} screen ${i + 1}: render target missing`);
              continue;
            }

            try {
              const { cW: eCW, cH: eCH } = getCanvas(dev, state.orientation);
              const dataUrl = await captureSlide(el, eCW, eCH, size.w, size.h);
              const base64 = dataUrl.split(",")[1] || "";
              const filename = `${String(i + 1).padStart(2, "0")}-${slide.layout}.png`;

              // Folder structure inside ZIP: Device folder (e.g. iPhone, iPad, Android Phone)
              let pathInZip: string;
              if (locales.length > 1 && sizes.length > 1) {
                pathInZip = `${deviceFolder}/${locale}/${size.w}x${size.h}/${filename}`;
              } else if (locales.length > 1) {
                pathInZip = `${deviceFolder}/${locale}/${filename}`;
              } else if (sizes.length > 1) {
                pathInZip = `${deviceFolder}/${size.w}x${size.h}/${filename}`;
              } else {
                pathInZip = `${deviceFolder}/${filename}`;
              }

              zip.file(pathInZip, base64, { base64: true });

              // Store-ready structure
              const storePath = `AppStore_Structure/${platform}/${dev}/${size.w}x${size.h}/${locale}/${filename}`;
              zip.file(storePath, base64, { base64: true });

              okCount += 1;
            } catch (e) {
              failed += 1;
              const msg = e instanceof Error ? e.message : String(e);
              errors.push(`${dev} ${locale} ${size.w}×${size.h} screen ${i + 1}: ${msg}`);
              console.error("Export failed", { dev, slideId: slide.id, locale, size }, e);
            }
          }
        }
      }
    }

    setExportDeviceOverride(null);
    setExportLocaleOverride(null);
    setExporting(null);

    if (okCount > 0) {
      try {
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${slugify(state.appName)}-all-devices-bundle.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) {
        toast.error("Couldn't generate export ZIP bundle");
        console.error(e);
        return;
      }
    }

    if (failed === 0) {
      toast.success(`Exported ${okCount} PNGs across ${configuredDevices.length} device decks!`);
    } else if (okCount === 0) {
      toast.error(`All ${failed} renders failed`, {
        description: errors.slice(0, 3).join("\n"),
      });
    } else {
      toast.error(`${failed} of ${totalUnits} renders failed`, {
        description: errors.slice(0, 3).join("\n"),
      });
    }
  }

  async function captureSlide(
    el: HTMLElement,
    sourceW: number,
    sourceH: number,
    exportW: number,
    exportH: number,
  ) {
    // html-to-image needs the node at (0,0). Let the library scale the source
    // canvas into the requested output dimensions; CSS transforms leave
    // transparent gutters when export aspect ratios differ by a few pixels.
    const prev = {
      left: el.style.left,
      top: el.style.top,
      position: el.style.position,
      transform: el.style.transform,
      transformOrigin: el.style.transformOrigin,
      zIndex: el.style.zIndex,
    };
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.position = "absolute";
    el.style.transform = "none";
    el.style.transformOrigin = "top left";
    el.style.zIndex = "-1";
    try {
      const dataUrl = await toPng(el, {
        width: sourceW,
        height: sourceH,
        canvasWidth: exportW,
        canvasHeight: exportH,
        pixelRatio: 1,
        cacheBust: false,
        backgroundColor: "#ffffff",
      });
      return dataUrl;
    } finally {
      el.style.left = prev.left || "-99999px";
      el.style.top = prev.top || "0px";
      el.style.position = prev.position || "absolute";
      el.style.transform = prev.transform;
      el.style.transformOrigin = prev.transformOrigin;
      el.style.zIndex = prev.zIndex;
    }
  }

  // ---------- Render ----------

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p className="text-sm">Loading editor…</p>
        </div>
      </div>
    );
  }

  const { cW, cH } = getCanvas(state.device, state.orientation);
  const busy = !!exporting;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Toaster position="top-right" richColors closeButton />
      <Toolbar
        appName={state.appName}
        setAppName={(v) => setState((p) => ({ ...p, appName: v }))}
        connectedCanvas={state.connectedCanvas}
        setConnectedCanvas={(v) => setState((p) => ({ ...p, connectedCanvas: v }))}
        locale={state.locale}
        setLocale={(v) => setState((p) => ({ ...p, locale: v }))}
        locales={state.locales}
        device={state.device}
        setDevice={(v) => setState((p) => ({ ...p, device: v }))}
        orientation={state.orientation}
        setOrientation={(v) => setState((p) => ({ ...p, orientation: v }))}
        onExport={exportAll}
        onSaveProject={handleSaveProject}
        onOpenProject={handleOpenProject}
        onResetAll={() => {
          reset();
          setActiveSlideId(null);
          toast.success("Reset all devices to defaults");
        }}
        onResetDevice={() => {
          resetDevice(state.device);
          setActiveSlideId(null);
          toast.success(`Reset ${state.device} to defaults`);
        }}
        exporting={exporting}
        savedAt={savedAt}
        saveError={saveError}
        busy={busy}
      />

      <div className="flex flex-1 overflow-hidden md:flex-row flex-col">
        <aside className="md:w-72 w-full shrink-0 border-r bg-card md:max-h-none max-h-64 overflow-hidden">
          <Sidebar
            slides={currentSlides}
            activeId={activeSlide?.id || null}
            device={state.device}
            orientation={state.orientation}
            theme={theme}
            locale={state.locale}
            appName={state.appName}
            appIcon={state.appIcon}
            connectedCanvas={state.connectedCanvas}
            disabled={busy}
            onReorder={reorderSlides}
            onSelect={setActiveSlideId}
            onDelete={deleteSlide}
            onDuplicate={duplicateSlide}
            onAdd={addSlide}
          />
        </aside>

        <main className="flex flex-1 items-stretch overflow-hidden min-h-0">
          {activeSlide && currentSlides.length > 0 ? (
            <PreviewStage
              slides={currentSlides}
              activeSlideId={activeSlide.id}
              device={state.device}
              orientation={state.orientation}
              theme={theme}
              locale={state.locale}
              appName={state.appName}
              appIcon={state.appIcon}
              connectedCanvas={state.connectedCanvas}
              selectedElement={selectedElement}
              onActiveSlideChange={setActiveSlideId}
              onLabelChange={(slide, v) => patchLocalized(slide, "label", v)}
              onHeadlineChange={(slide, v) => patchLocalized(slide, "headline", v)}
              onTextElementTextChange={patchTextElementText}
              onElementChange={patchElementTransform}
              onSelectElement={setSelectedElement}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No screen selected</p>
              <p>Add a screen on the left to get started.</p>
            </div>
          )}
        </main>

        <aside className="md:w-80 w-full shrink-0 border-l bg-card md:max-h-none max-h-96 overflow-hidden">
          {activeSlide ? (
            <Inspector
              slide={activeSlide}
              device={state.device}
              orientation={state.orientation}
              locale={state.locale}
              appIcon={state.appIcon}
              onAppIconChange={(icon) => setState((prev) => ({ ...prev, appIcon: icon }))}
              selectedElementId={
                selectedElement?.slideId === activeSlide.id ? selectedElement.elementId : null
              }
              onChange={(patch) => patchSlide(activeSlide.id, patch)}
              onSelectElement={(elementId) =>
                setSelectedElement(
                  elementId ? { slideId: activeSlide.id, elementId } : null,
                )
              }
              onApplyBackgroundToAll={applyBackgroundToAll}
              onResetToDefault={resetSlideToDefault}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Nothing to inspect</p>
              <p className="text-xs">Screen settings will appear here once you add or select one.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Off-screen export container — full-resolution canvases for html-to-image. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: -99999,
          top: 0,
          pointerEvents: "none",
        }}
      >
        {activeExportSlides.length > 0 && (
          <div
            ref={exportRef}
            style={{
              width: exportCW,
              height: exportCH,
              overflow: "hidden",
              position: "absolute",
              left: -99999,
              top: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: -exportSlideIndex * exportCW,
                top: 0,
                width: exportCW * activeExportSlides.length,
                height: exportCH,
              }}
            >
              <DeckCanvas
                slides={activeExportSlides}
                device={activeExportDevice}
                orientation={state.orientation}
                theme={theme}
                locale={exportLocaleOverride ?? state.locale}
                appName={state.appName}
                appIcon={state.appIcon}
                connectedCanvas={state.connectedCanvas}
                hideEmpty
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "screenshots"
  );
}

function slideNeedsScreenshot(device: Device, slide: Slide) {
  if (device === "feature-graphic") return false;
  return slide.layout !== "no-device" && slide.layout !== "feature-graphic";
}

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
