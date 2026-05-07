import { Action, ActionPanel, Clipboard, Form, Icon, LocalStorage, Toast, open, showToast } from "@raycast/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unlink } from "node:fs/promises";
import {
  ClipboardFileEntry,
  ConverterDecision,
  OutputDestination,
  buildOutputPath,
  convertWithTool,
  detectConverter,
  getFileExt,
  getRecommendedOutputs,
  normalizeExt,
  readClipboardFileEntry,
} from "./lib/convert-core";

type ConvertFormValues = {
  outputFormat: string;
  destination: OutputDestination;
  outputDir?: string[];
  overwrite: boolean;
  openAfter: boolean;
};

type PersistedFormState = {
  outputFormat?: string;
  destination?: OutputDestination;
  outputDir?: string | null;
  overwrite?: boolean;
  openAfter?: boolean;
};

const FORM_STATE_KEY = "convert-clipboard-form-state-v1";
const CLIPBOARD_POLL_MS = 1200;

const isOutputDestination = (value: string): value is OutputDestination =>
  value === "clipboard" || value === "save" || value === "both";

export default function Command() {
  const [clipboardEntry, setClipboardEntry] = useState<ClipboardFileEntry | null>(null);
  const [decision, setDecision] = useState<ConverterDecision | null>(null);
  const [outputFormat, setOutputFormat] = useState<string>("");
  const [destination, setDestination] = useState<OutputDestination>("clipboard");
  const [outputDir, setOutputDir] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);
  const [clipboardLoading, setClipboardLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const clipboardRefreshInFlight = useRef(false);

  const inputPath = clipboardEntry?.path ?? null;

  useEffect(() => {
    let cancelled = false;
    const loadFormState = async () => {
      try {
        const raw = await LocalStorage.getItem<string>(FORM_STATE_KEY);
        if (cancelled || !raw) return;
        const state = JSON.parse(raw) as PersistedFormState;
        if (state.outputFormat) setOutputFormat(normalizeExt(state.outputFormat));
        if (state.destination && isOutputDestination(state.destination)) setDestination(state.destination);
        if (state.outputDir) setOutputDir([state.outputDir]);
        if (typeof state.overwrite === "boolean") setOverwrite(state.overwrite);
        if (typeof state.openAfter === "boolean") setOpenAfter(state.openAfter);
      } catch {
        // ignore malformed persisted state
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    };
    void loadFormState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    const state: PersistedFormState = {
      outputFormat: outputFormat || undefined,
      destination,
      outputDir: outputDir[0] ?? null,
      overwrite,
      openAfter,
    };
    void LocalStorage.setItem(FORM_STATE_KEY, JSON.stringify(state));
  }, [destination, openAfter, outputDir, outputFormat, overwrite, prefsLoaded]);

  const applyClipboardEntry = useCallback((nextEntry: ClipboardFileEntry | null) => {
    setClipboardEntry((previousEntry) => {
      if (!nextEntry) return null;
      if (previousEntry && previousEntry.signature === nextEntry.signature && previousEntry.kind === nextEntry.kind) {
        if (nextEntry.kind === "image" && nextEntry.path !== previousEntry.path) {
          void unlink(nextEntry.path).catch(() => undefined);
        }
        return previousEntry;
      }
      return nextEntry;
    });
  }, []);

  const loadClipboard = useCallback(async () => {
    if (clipboardRefreshInFlight.current) return;
    clipboardRefreshInFlight.current = true;
    try {
      const entry = await readClipboardFileEntry();
      applyClipboardEntry(entry);
    } finally {
      clipboardRefreshInFlight.current = false;
      setClipboardLoading(false);
    }
  }, [applyClipboardEntry, clipboardRefreshInFlight]);

  useEffect(() => {
    void loadClipboard();
    const interval = setInterval(() => {
      void loadClipboard();
    }, CLIPBOARD_POLL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [loadClipboard]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!inputPath) {
        setDecision(null);
        setDetecting(false);
        return;
      }
      setDetecting(true);
      try {
        const resolved = await detectConverter(getFileExt(inputPath));
        if (cancelled) return;
        setDecision(resolved);
        if (resolved) {
          setOutputFormat((currentFormat) => {
            const normalizedCurrent = normalizeExt(currentFormat);
            if (
              normalizedCurrent &&
              (resolved.tool.output.length === 0 || resolved.tool.output.includes(normalizedCurrent))
            ) {
              return normalizedCurrent;
            }
            return resolved.defaultOutput;
          });
        }
      } finally {
        if (!cancelled) setDetecting(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [inputPath]);

  const outputFormats = decision?.tool.output ?? [];
  const recommended = useMemo(() => {
    if (!decision) return { recommended: [], all: [] as string[] };
    const recommendedSet = new Set(getRecommendedOutputs(decision.category, outputFormats));
    if (decision.defaultOutput) recommendedSet.add(decision.defaultOutput);
    const recommendedList = Array.from(recommendedSet);
    const remaining = outputFormats.filter((format) => !recommendedSet.has(format));
    return { recommended: recommendedList, all: remaining };
  }, [decision, outputFormats]);

  const handleSubmit = async (values: ConvertFormValues) => {
    void values;
    if (!inputPath) {
      await showToast(Toast.Style.Failure, "No clipboard file found");
      return;
    }
    let resolvedDecision = decision;
    if (!resolvedDecision) {
      resolvedDecision = await detectConverter(getFileExt(inputPath));
      setDecision(resolvedDecision);
      if (resolvedDecision && !outputFormat) {
        setOutputFormat(resolvedDecision.defaultOutput);
      }
    }
    if (!resolvedDecision) {
      await showToast(Toast.Style.Failure, "No compatible converter found");
      return;
    }
    const outputExt = normalizeExt(outputFormat || resolvedDecision.defaultOutput);
    if (!outputExt) {
      await showToast(Toast.Style.Failure, "Choose a target format");
      return;
    }
    const supportedOutputs = resolvedDecision.tool.output;
    if (supportedOutputs.length > 0 && !supportedOutputs.includes(outputExt)) {
      await showToast(
        Toast.Style.Failure,
        `.${outputExt} is not supported by ${resolvedDecision.kind}`,
        "Choose a supported format from the dropdown.",
      );
      return;
    }
    const outputDirPath = destination === "save" || destination === "both" ? (outputDir?.[0] ?? null) : null;
    const outputPath = buildOutputPath(inputPath, outputExt, outputDirPath, destination);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Converting file",
      message: `${resolvedDecision.kind} -> .${outputExt}`,
    });

    try {
      const resultPath = await convertWithTool({
        inputPath,
        outputPath,
        outputExt,
        overwrite: values.overwrite,
        converter: resolvedDecision.kind,
        tool: resolvedDecision.tool,
      });

      if (destination === "clipboard" || destination === "both") {
        await Clipboard.copy({ file: resultPath });
      }

      toast.style = Toast.Style.Success;
      toast.title = destination === "clipboard" ? "Copied to clipboard" : "Conversion complete";
      toast.message = resultPath;

      if ((destination === "save" || destination === "both") && openAfter) {
        await open(resultPath);
      }
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Conversion failed";
      toast.message = error instanceof Error ? error.message : "Unknown error";
    }
  };

  return (
    <Form
      isLoading={clipboardLoading || detecting || !prefsLoaded}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.ArrowRight} title="Convert" onSubmit={handleSubmit} />
          <Action icon={Icon.Clipboard} title="Reload Clipboard" onAction={() => void loadClipboard()} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Clipboard Input"
        text={inputPath ?? "No file or image in clipboard. Copy a file or image to proceed."}
      />
      {outputFormats.length > 0 ? (
        <Form.Dropdown
          id="outputFormat"
          title="Target Format"
          placeholder="Search formats..."
          value={outputFormat}
          onChange={(value) => setOutputFormat(normalizeExt(value))}
        >
          {recommended.recommended.length > 0 && (
            <Form.Dropdown.Section title="Recommended">
              {recommended.recommended.map((format) => (
                <Form.Dropdown.Item key={format} value={format} title={format} />
              ))}
            </Form.Dropdown.Section>
          )}
          <Form.Dropdown.Section title="All Formats">
            {recommended.all.map((format) => (
              <Form.Dropdown.Item key={format} value={format} title={format} />
            ))}
          </Form.Dropdown.Section>
        </Form.Dropdown>
      ) : (
        <Form.TextField
          id="outputFormat"
          title="Target Format"
          value={outputFormat}
          onChange={(value) => setOutputFormat(normalizeExt(value))}
        />
      )}
      <Form.Dropdown
        id="destination"
        title="Output"
        value={destination}
        onChange={(value) => setDestination(value as OutputDestination)}
      >
        <Form.Dropdown.Item value="clipboard" title="Copy to Clipboard" />
        <Form.Dropdown.Item value="save" title="Save to Folder" />
        <Form.Dropdown.Item value="both" title="Save and Copy" />
      </Form.Dropdown>
      {(destination === "save" || destination === "both") && (
        <Form.FilePicker
          id="outputDir"
          title="Output Folder (Optional)"
          canChooseDirectories={true}
          canChooseFiles={false}
          allowMultipleSelection={false}
          value={outputDir}
          onChange={setOutputDir}
        />
      )}
      <Form.Checkbox
        id="overwrite"
        title="Overwrite Existing File"
        label="Overwrite if output already exists"
        value={overwrite}
        onChange={setOverwrite}
      />
      {(destination === "save" || destination === "both") && (
        <Form.Checkbox
          id="openAfter"
          title="Open After Convert"
          label="Open the converted file"
          value={openAfter}
          onChange={setOpenAfter}
        />
      )}
    </Form>
  );
}
