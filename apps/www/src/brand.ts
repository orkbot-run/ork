export const BRAND_KIT_PATH = "/brand/";
export const WORDMARK_SVG_PATH = "/brand/kit/orkbot-wordmark.svg";

export const BRAND_LOGOS = [
  {
    name: "Logo",
    file: "/brand/kit/orkbot-logo.png",
    preview: "/brand/kit/orkbot-logo-preview.webp",
    format: "PNG · 1712 × 576",
  },
  {
    name: "Wordmark",
    file: WORDMARK_SVG_PATH,
    preview: WORDMARK_SVG_PATH,
    format: "SVG",
  },
  {
    name: "App icon",
    file: "/brand/kit/orkbot-icon.png",
    preview: "/brand/kit/orkbot-icon-preview.webp",
    format: "PNG · 1024 × 1024",
  },
  {
    name: "Mascot",
    file: "/brand/kit/orkbot-mascot.png",
    preview: "/brand/kit/orkbot-mascot-preview.webp",
    format: "PNG · 700 × 700",
  },
] as const;

export const BRAND_COLORS = [
  { name: "Orange", hex: "#F97D16" },
  { name: "Black", hex: "#141414" },
  { name: "White", hex: "#FFFFFF" },
] as const;
