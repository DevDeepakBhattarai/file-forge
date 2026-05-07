import { Clipboard } from "@raycast/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { getPreferenceValues } from "@raycast/api";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

export type ConverterKind = "magick" | "ffmpeg" | "pandoc" | "libreoffice";
export type OutputDestination = "clipboard" | "save" | "both";
export type FileCategory = "image" | "audio" | "video" | "doc" | "unknown";

export type ToolFormats = {
  bin: string;
  input: string[];
  output: string[];
};

export type Preferences = {
  magickPath?: string;
  ffmpegPath?: string;
  pandocPath?: string;
  libreofficePath?: string;
};

export type ConverterDecision = {
  kind: ConverterKind;
  tool: ToolFormats;
  category: FileCategory;
  defaultOutput: string;
};

export type ClipboardFileKind = "file" | "image";

export type ClipboardFileEntry = {
  path: string;
  signature: string;
  kind: ClipboardFileKind;
};

const toolCache: Partial<Record<ConverterKind, ToolFormats | null>> = {};
const preferences = getPreferenceValues<Preferences>();

export const imagePreferredExts = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "svg",
  "ico",
  "psd",
  "tga",
]);

const audioExts = new Set(["aac", "aiff", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]);

const videoExts = new Set([
  "3g2",
  "3gp",
  "avi",
  "flv",
  "m2ts",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "mts",
  "ogv",
  "ts",
  "webm",
  "wmv",
]);

const ffmpegCommonOutputExts = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "webm",
]);

const pandocInputExts = new Set([
  "adoc",
  "asciidoc",
  "bib",
  "csv",
  "docbook",
  "docx",
  "epub",
  "htm",
  "html",
  "ipynb",
  "json",
  "latex",
  "ltx",
  "md",
  "mdown",
  "markdown",
  "mkd",
  "odt",
  "opml",
  "org",
  "pptx",
  "rst",
  "rtf",
  "tex",
  "textile",
  "tsv",
  "typ",
  "typst",
  "wiki",
  "xls",
  "xlsx",
  "xml",
]);

const pandocCommonOutputExts = new Set([
  "adoc",
  "asciidoc",
  "docx",
  "epub",
  "htm",
  "html",
  "ipynb",
  "json",
  "latex",
  "md",
  "odt",
  "opml",
  "org",
  "pdf",
  "pptx",
  "rst",
  "rtf",
  "tex",
  "txt",
  "typ",
  "typst",
  "xml",
]);

const libreOfficeInput = [
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "csv",
  "html",
  "htm",
];

const libreOfficeOutput = ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "txt", "html"];

export const normalizeExt = (value: string) => value.trim().replace(/^\./, "").toLowerCase();

export const getFileExt = (filePath: string) => normalizeExt(path.extname(filePath));

const uniqueSorted = (values: string[]) => Array.from(new Set(values.filter(Boolean))).sort();

const normalizePref = (value?: string) => (value ?? "").trim();

const canRun = async (cmd: string, args: string[]) => {
  try {
    await execFileAsync(cmd, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
};

const resolvePreferred = async (value: string | undefined, probeArgs: string[]) => {
  const preferred = normalizePref(value);
  if (!preferred) return null;
  const ok = await canRun(preferred, probeArgs);
  return ok ? preferred : null;
};

const findBinary = async (cmd: string): Promise<string | null> => {
  const locator = isWindows ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [cmd], {
      windowsHide: true,
    });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (first) return first;
  } catch {
    // ignore
  }
  return null;
};

const findExistingExecutable = async (candidates: Array<string | undefined | null>) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }
  return null;
};

const findBrowserForPdf = async () => {
  const resolved = await findBinary(isWindows ? "msedge" : "google-chrome");
  if (resolved) return resolved;

  if (isWindows) {
    return await findExistingExecutable([
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    ]);
  }

  return await findExistingExecutable([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]);
};

const findMagickOnWindows = async (): Promise<string | null> => {
  if (!isWindows) return null;
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(
    (root): root is string => !!root,
  );
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.toLowerCase().startsWith("imagemagick-")) continue;
        const exePath = path.join(root, entry.name, "magick.exe");
        try {
          await access(exePath);
          return exePath;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
};

const ensureMagick = async (): Promise<ToolFormats | null> => {
  if (toolCache.magick !== undefined) return toolCache.magick ?? null;

  let bin = await resolvePreferred(preferences.magickPath, ["-version"]);
  if (!bin) {
    const candidates = isWindows ? ["magick"] : ["magick", "convert"];
    for (const candidate of candidates) {
      const resolved = await findBinary(candidate);
      if (resolved) {
        bin = candidate;
        break;
      }
    }
  }
  if (!bin) {
    bin = await findMagickOnWindows();
  }
  if (!bin) {
    toolCache.magick = null;
    return null;
  }

  const formats = await loadMagickFormats(bin);
  toolCache.magick = { bin, ...formats };
  return toolCache.magick;
};

const ensureFfmpeg = async (): Promise<ToolFormats | null> => {
  if (toolCache.ffmpeg !== undefined) return toolCache.ffmpeg ?? null;
  let bin = await resolvePreferred(preferences.ffmpegPath, ["-version"]);
  if (!bin) {
    bin = await findBinary("ffmpeg");
  }
  if (!bin && isWindows) {
    bin = await findExistingExecutable([
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
      path.join(os.homedir(), "scoop", "shims", "ffmpeg.exe"),
      path.join(
        os.homedir(),
        "AppData",
        "Local",
        "Microsoft",
        "WinGet",
        "Packages",
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "ffmpeg.exe",
      ),
      process.env["ChocolateyInstall"] ? path.join(process.env["ChocolateyInstall"], "bin", "ffmpeg.exe") : null,
    ]);
  }
  if (!bin) {
    toolCache.ffmpeg = null;
    return null;
  }
  const formats = await loadFfmpegFormats(bin);
  toolCache.ffmpeg = { bin, ...formats };
  return toolCache.ffmpeg;
};

const ensurePandoc = async (): Promise<ToolFormats | null> => {
  if (toolCache.pandoc !== undefined) return toolCache.pandoc ?? null;
  let bin = await resolvePreferred(preferences.pandocPath, ["--version"]);
  if (!bin) {
    bin = await findBinary("pandoc");
  }
  if (!bin && isWindows) {
    bin = await findExistingExecutable([
      path.join(os.homedir(), "AppData", "Local", "Pandoc", "pandoc.exe"),
      process.env["ProgramData"] ? path.join(process.env["ProgramData"], "chocolatey", "bin", "pandoc.exe") : null,
      process.env["ChocolateyInstall"] ? path.join(process.env["ChocolateyInstall"], "bin", "pandoc.exe") : null,
      path.join(os.homedir(), "scoop", "shims", "pandoc.exe"),
    ]);
  }
  if (!bin) {
    toolCache.pandoc = null;
    return null;
  }
  const formats = await loadPandocFormats(bin);
  toolCache.pandoc = { bin, ...formats };
  return toolCache.pandoc;
};

const ensureLibreOffice = async (): Promise<ToolFormats | null> => {
  if (toolCache.libreoffice !== undefined) return toolCache.libreoffice ?? null;
  const preferred = await resolvePreferred(preferences.libreofficePath, ["--version"]);
  if (preferred) {
    toolCache.libreoffice = {
      bin: preferred,
      input: libreOfficeInput,
      output: libreOfficeOutput,
    };
    return toolCache.libreoffice;
  }
  const candidates = isWindows ? ["soffice"] : ["soffice", "libreoffice"];
  let bin: string | null = null;
  for (const candidate of candidates) {
    const resolved = await findBinary(candidate);
    if (resolved) {
      bin = candidate;
      break;
    }
  }
  if (!bin) {
    toolCache.libreoffice = null;
    return null;
  }
  toolCache.libreoffice = {
    bin,
    input: libreOfficeInput,
    output: libreOfficeOutput,
  };
  return toolCache.libreoffice;
};

const loadMagickFormats = async (bin: string) => {
  try {
    const { stdout } = await execFileAsync(bin, ["-list", "format"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10,
    });
    const input: string[] = [];
    const output: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Format") || trimmed.startsWith("--")) {
        continue;
      }
      let format = "";
      let mode = "";
      const match = trimmed.match(/^(\S+)\s+\S+\s+([r-][w-][+-])\s+/i);
      if (match) {
        format = match[1];
        mode = match[2];
      } else {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          format = parts[0];
          mode = parts[2];
        }
      }
      if (!format || !mode) continue;
      const normalized = normalizeExt(format.replace(/\*$/, ""));
      const modeLower = mode.toLowerCase();
      if (modeLower.includes("r")) input.push(normalized);
      if (modeLower.includes("w")) output.push(normalized);
    }
    return { input: uniqueSorted(input), output: uniqueSorted(output) };
  } catch {
    return { input: [], output: [] };
  }
};

const loadFfmpegFormats = async (bin: string) => {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["-hide_banner", "-formats"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10,
    });
    const input: string[] = [];
    const output: string[] = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
      const match = line.match(/^\s*([D.])([E.])\s+(\S+)/);
      if (!match) continue;
      const demux = match[1] === "D";
      const mux = match[2] === "E";
      const formats = match[3].split(",").map((format) => normalizeExt(format));
      if (demux) input.push(...formats);
      if (mux) output.push(...formats);
    }
    return {
      input: uniqueSorted([...input, ...audioExts, ...videoExts]),
      output: uniqueSorted([...output, ...ffmpegCommonOutputExts]),
    };
  } catch {
    return {
      input: uniqueSorted([...audioExts, ...videoExts]),
      output: uniqueSorted([...ffmpegCommonOutputExts]),
    };
  }
};

const loadPandocFormats = async (bin: string) => {
  try {
    const [inputResult, outputResult] = await Promise.all([
      execFileAsync(bin, ["--list-input-formats"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync(bin, ["--list-output-formats"], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const input = uniqueSorted([
      ...inputResult.stdout.split(/\s+/).map((format) => normalizeExt(format)),
      ...pandocInputExts,
    ]);
    const output = uniqueSorted([
      ...outputResult.stdout.split(/\s+/).map((format) => normalizeExt(format)),
      ...pandocCommonOutputExts,
    ]);
    return { input, output };
  } catch {
    return {
      input: uniqueSorted([...pandocInputExts]),
      output: uniqueSorted([...pandocCommonOutputExts]),
    };
  }
};

const getCategory = (ext: string, kind: ConverterKind): FileCategory => {
  if (kind === "magick") return "image";
  if (kind === "pandoc" || kind === "libreoffice") return "doc";
  if (audioExts.has(ext)) return "audio";
  if (videoExts.has(ext)) return "video";
  return "unknown";
};

export const pickDefaultOutput = (category: FileCategory, outputs: string[]) => {
  const preferredByCategory: Record<FileCategory, string[]> = {
    image: ["png", "jpg", "jpeg", "webp"],
    audio: ["wav", "mp3", "aac"],
    video: ["mp3", "m4a", "wav", "mp4", "mov", "mkv"],
    doc: ["pdf", "docx", "html", "md", "txt"],
    unknown: ["png", "pdf", "mp4"],
  };
  const preferred = preferredByCategory[category] ?? [];
  for (const candidate of preferred) {
    if (outputs.includes(candidate)) return candidate;
  }
  return outputs[0] ?? preferred[0] ?? "png";
};

export const getRecommendedOutputs = (category: FileCategory, outputs: string[]) => {
  const preferredByCategory: Record<FileCategory, string[]> = {
    image: ["png", "jpg", "jpeg", "webp"],
    audio: ["wav", "mp3", "aac", "flac", "m4a", "ogg"],
    video: ["mp3", "m4a", "wav", "aac", "mp4", "mov", "mkv", "webm"],
    doc: ["pdf", "docx", "html", "md", "txt", "pptx", "epub"],
    unknown: ["png", "pdf", "mp4"],
  };
  return preferredByCategory[category].filter((format) => outputs.length === 0 || outputs.includes(format));
};

export const detectConverter = async (ext: string): Promise<ConverterDecision | null> => {
  const magick = await ensureMagick();
  const ffmpeg = await ensureFfmpeg();
  const pandoc = await ensurePandoc();
  const libreoffice = await ensureLibreOffice();
  const isKnownMediaExt = audioExts.has(ext) || videoExts.has(ext);
  const isKnownDocExt = pandocInputExts.has(ext) || libreOfficeInput.includes(ext);

  if (imagePreferredExts.has(ext) && magick?.input.includes(ext)) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }
  if (ffmpeg?.input.includes(ext)) {
    const category = getCategory(ext, "ffmpeg");
    return {
      kind: "ffmpeg",
      tool: ffmpeg,
      category,
      defaultOutput: pickDefaultOutput(category, ffmpeg.output),
    };
  }
  if (isKnownMediaExt) {
    return null;
  }
  if (pandoc?.input.includes(ext)) {
    const category = getCategory(ext, "pandoc");
    return {
      kind: "pandoc",
      tool: pandoc,
      category,
      defaultOutput: pickDefaultOutput(category, pandoc.output),
    };
  }
  if (libreoffice?.input.includes(ext)) {
    const category = getCategory(ext, "libreoffice");
    return {
      kind: "libreoffice",
      tool: libreoffice,
      category,
      defaultOutput: pickDefaultOutput(category, libreoffice.output),
    };
  }
  if (isKnownDocExt) {
    return null;
  }
  if (magick?.input.includes(ext)) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }

  if (magick) {
    const category = getCategory(ext, "magick");
    return {
      kind: "magick",
      tool: magick,
      category,
      defaultOutput: pickDefaultOutput(category, magick.output),
    };
  }
  if (ffmpeg) {
    const category = getCategory(ext, "ffmpeg");
    return {
      kind: "ffmpeg",
      tool: ffmpeg,
      category,
      defaultOutput: pickDefaultOutput(category, ffmpeg.output),
    };
  }
  if (pandoc) {
    const category = getCategory(ext, "pandoc");
    return {
      kind: "pandoc",
      tool: pandoc,
      category,
      defaultOutput: pickDefaultOutput(category, pandoc.output),
    };
  }
  if (libreoffice) {
    const category = getCategory(ext, "libreoffice");
    return {
      kind: "libreoffice",
      tool: libreoffice,
      category,
      defaultOutput: pickDefaultOutput(category, libreoffice.output),
    };
  }

  return null;
};

export const runCommand = async (cmd: string, args: string[]) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const details = [err.message, err.stdout, err.stderr].filter(Boolean).join("\n");
    throw new Error(details || "Conversion failed");
  }
};

const isMissingPandocPdfEngineError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return /pdflatex not found|xelatex not found|lualatex not found|pdf engine|--pdf-engine/i.test(error.message);
};

const hasPandocPdfEngine = async () => {
  const engines = ["pdflatex", "xelatex", "lualatex", "typst", "wkhtmltopdf", "weasyprint", "prince"];
  for (const engine of engines) {
    const resolved = await findBinary(engine);
    if (resolved && (await canRun(resolved, ["--version"]))) {
      return true;
    }
  }
  return false;
};

const waitForFile = async (filePath: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await access(filePath);
};

const convertPandocPdfViaBrowser = async (tool: ToolFormats, inputPath: string, outputPath: string) => {
  const browser = await findBrowserForPdf();
  if (!browser) {
    throw new Error(
      "Pandoc can read this file, but PDF output needs a PDF engine. Install LaTeX, Typst, wkhtmltopdf, Edge, or Chrome.",
    );
  }

  const htmlPath = path.join(os.tmpdir(), `file-forge-pandoc-${randomUUID()}.html`);
  const browserUserDataDir = path.join(os.tmpdir(), `file-forge-browser-${randomUUID()}`);
  await runCommand(tool.bin, [inputPath, "--standalone", "-o", htmlPath]);
  await runCommand(browser, [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${browserUserDataDir}`,
    "--allow-file-access-from-files",
    `--print-to-pdf=${outputPath}`,
    pathToFileURL(htmlPath).toString(),
  ]);

  try {
    await waitForFile(outputPath);
  } catch {
    throw new Error("Browser PDF fallback finished but did not create an output PDF.");
  }
};

export const convertWithTool = async (opts: {
  inputPath: string;
  outputPath: string;
  outputExt: string;
  overwrite: boolean;
  converter: ConverterKind;
  tool: ToolFormats;
}) => {
  const { inputPath, outputPath, outputExt, overwrite, converter, tool } = opts;
  const inputExt = getFileExt(inputPath);
  const outputExtNormalized = normalizeExt(outputExt);

  if (!overwrite) {
    try {
      await access(outputPath);
      throw new Error("Output file already exists. Enable overwrite or choose another name.");
    } catch {
      // file does not exist
    }
  }

  switch (converter) {
    case "magick":
      {
        const args: string[] = [];
        const alphaFormats = new Set(["png", "webp", "gif", "tif", "tiff"]);
        if (inputExt === "svg" && alphaFormats.has(outputExtNormalized)) {
          args.push("-background", "none");
        }
        args.push(inputPath);
        if (inputExt === "svg" && alphaFormats.has(outputExtNormalized)) {
          args.push("-alpha", "on");
        }
        args.push(outputPath);
        await runCommand(tool.bin, args);
      }
      return outputPath;
    case "ffmpeg": {
      const args = ["-hide_banner", "-loglevel", "error"];
      args.push(overwrite ? "-y" : "-n");
      args.push("-i", inputPath);
      if (audioExts.has(outputExtNormalized)) {
        args.push("-vn");
      }
      args.push(outputPath);
      await runCommand(tool.bin, args);
      return outputPath;
    }
    case "pandoc":
      if (outputExtNormalized === "pdf" && !(await hasPandocPdfEngine())) {
        await convertPandocPdfViaBrowser(tool, inputPath, outputPath);
        return outputPath;
      }
      try {
        await runCommand(tool.bin, [inputPath, "-o", outputPath]);
      } catch (error) {
        if (outputExtNormalized !== "pdf") {
          throw error;
        }
        if (!isMissingPandocPdfEngineError(error)) {
          await convertPandocPdfViaBrowser(tool, inputPath, outputPath);
          return outputPath;
        }
        await convertPandocPdfViaBrowser(tool, inputPath, outputPath);
      }
      return outputPath;
    case "libreoffice": {
      const outDir = path.dirname(outputPath);
      await runCommand(tool.bin, ["--headless", "--convert-to", outputExt, "--outdir", outDir, inputPath]);
      return outputPath;
    }
    default:
      throw new Error("Unsupported converter");
  }
};

export const buildOutputPath = (
  inputPath: string,
  outputExt: string,
  outputDir: string | null,
  destination: OutputDestination,
) => {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const safeExt = normalizeExt(outputExt);
  if (destination === "clipboard") {
    const unique = randomUUID();
    return path.join(os.tmpdir(), `${baseName}-converted-${unique}.${safeExt}`);
  }
  const dir = outputDir && outputDir.length > 0 ? outputDir : path.dirname(inputPath);
  return path.join(dir, `${baseName}.${safeExt}`);
};

const getFileSignature = async (filePath: string) => {
  try {
    const stats = await stat(filePath);
    return `file:${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `file:${filePath}`;
  }
};

const getImageSignature = async (filePath: string) => {
  try {
    const image = await readFile(filePath);
    return `image:${createHash("sha256").update(image).digest("hex")}`;
  } catch {
    try {
      const stats = await stat(filePath);
      return `image:size:${stats.size}`;
    } catch {
      return "image:unknown";
    }
  }
};

export const readClipboardFileEntry = async (): Promise<ClipboardFileEntry | null> => {
  const content = await Clipboard.read();
  if (content.file) {
    const resolvedPath = content.file.startsWith("file://") ? fileURLToPath(content.file) : content.file;
    return {
      path: resolvedPath,
      signature: await getFileSignature(resolvedPath),
      kind: "file",
    };
  }
  if (content.text) {
    const trimmed = content.text.trim();
    if (!trimmed) return null;
    const pathCandidate = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
    try {
      await access(pathCandidate);
      return {
        path: pathCandidate,
        signature: await getFileSignature(pathCandidate),
        kind: "file",
      };
    } catch {
      return null;
    }
  }
  const imagePath = await readClipboardImageToTemp();
  if (imagePath) {
    return {
      path: imagePath,
      signature: await getImageSignature(imagePath),
      kind: "image",
    };
  }
  return null;
};

export const readClipboardFile = async (): Promise<string | null> => {
  const entry = await readClipboardFileEntry();
  return entry?.path ?? null;
};

const readClipboardImageToTemp = async (): Promise<string | null> => {
  if (isWindows) {
    return await readClipboardImageWindows();
  }
  return await readClipboardImageMac();
};

const readClipboardImageWindows = async (): Promise<string | null> => {
  const tempPath = path.join(os.tmpdir(), `raycast-clipboard-${randomUUID()}.png`);
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($null -eq $img) { exit 2 }",
    `$img.Save('${tempPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "$img.Dispose();",
  ].join(" ");
  try {
    await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    await access(tempPath);
    return tempPath;
  } catch {
    return null;
  }
};

const readClipboardImageMac = async (): Promise<string | null> => {
  const pngpaste = await findBinary("pngpaste");
  if (!pngpaste) return null;
  const tempPath = path.join(os.tmpdir(), `raycast-clipboard-${randomUUID()}.png`);
  try {
    await execFileAsync(pngpaste, [tempPath], {
      maxBuffer: 1024 * 1024,
    });
    await access(tempPath);
    return tempPath;
  } catch {
    return null;
  }
};

export const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
};

export const isImageExt = (ext: string) => imagePreferredExts.has(ext);
