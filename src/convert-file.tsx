import { Action, ActionPanel, Clipboard, Form, Icon, LocalStorage, Toast, open, showToast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
  ConverterDecision,
  OutputDestination,
  buildOutputPath,
  convertImagesToPdf,
  convertWithTool,
  detectConverter,
  getFileExt,
  getRecommendedOutputs,
  normalizeExt,
} from "./lib/convert-core";
import { fileURLToPath } from "node:url";
import path from "node:path";

type ConvertFormValues = {
  input: string[];
  outputFormat: string;
  destination: OutputDestination;
  outputDir?: string[];
  overwrite: boolean;
  openAfter: boolean;
};

const normalizeInputPath = (value: string) => (value.startsWith("file://") ? fileURLToPath(value) : value);
const FORM_STATE_KEY = "convert-file-form-state-v1";

type PersistedFormState = {
  outputFormat?: string;
  destination?: OutputDestination;
  outputDir?: string | null;
  overwrite?: boolean;
  openAfter?: boolean;
};

const isOutputDestination = (value: string): value is OutputDestination =>
  value === "clipboard" || value === "save" || value === "both";

type ConversionJob = {
  inputPath: string;
  outputPath: string;
  decision: ConverterDecision;
};

export default function Command() {
  const [inputPaths, setInputPaths] = useState<string[]>([]);
  const [decision, setDecision] = useState<ConverterDecision | null>(null);
  const [outputFormat, setOutputFormat] = useState<string>("");
  const [destination, setDestination] = useState<OutputDestination>("clipboard");
  const [outputDir, setOutputDir] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const primaryInputPath = inputPaths[0] ?? null;

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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!primaryInputPath) {
        setDecision(null);
        setDetecting(false);
        return;
      }
      setDetecting(true);
      try {
        const resolved = await detectConverter(getFileExt(primaryInputPath));
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
  }, [primaryInputPath]);

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
    const selectedInputPaths = (values.input?.length ? values.input : inputPaths).map(normalizeInputPath);
    if (selectedInputPaths.length === 0) {
      await showToast(Toast.Style.Failure, "Select at least one file");
      return;
    }

    const primaryInput = selectedInputPaths[0];
    let primaryDecision = decision;
    if (!primaryDecision || primaryInputPath !== primaryInput) {
      primaryDecision = await detectConverter(getFileExt(primaryInput));
      setDecision(primaryDecision);
      if (primaryDecision && !outputFormat) {
        setOutputFormat(primaryDecision.defaultOutput);
      }
    }
    if (!primaryDecision) {
      await showToast(Toast.Style.Failure, "No compatible converter found", primaryInput);
      return;
    }

    const outputExt = normalizeExt(values.outputFormat || outputFormat || primaryDecision.defaultOutput);
    if (!outputExt) {
      await showToast(Toast.Style.Failure, "Choose a target format");
      return;
    }
    const selectedDestination = values.destination;
    const outputDirPath =
      selectedDestination === "save" || selectedDestination === "both" ? (values.outputDir?.[0] ?? null) : null;

    const conversionJobs: ConversionJob[] = [];
    for (const inputPath of selectedInputPaths) {
      const resolvedDecision = await detectConverter(getFileExt(inputPath));
      if (!resolvedDecision) {
        await showToast(Toast.Style.Failure, "No compatible converter found", inputPath);
        return;
      }
      const supportedOutputs = resolvedDecision.tool.output;
      if (supportedOutputs.length > 0 && !supportedOutputs.includes(outputExt)) {
        await showToast(
          Toast.Style.Failure,
          `.${outputExt} is not supported by ${resolvedDecision.kind}`,
          path.basename(inputPath),
        );
        return;
      }
      conversionJobs.push({
        inputPath,
        outputPath: buildOutputPath(inputPath, outputExt, outputDirPath, selectedDestination),
        decision: resolvedDecision,
      });
    }
    const shouldMergeImagesToPdf =
      selectedInputPaths.length > 1 &&
      outputExt === "pdf" &&
      conversionJobs.every((job) => job.decision.kind === "magick" && job.decision.category === "image");

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: shouldMergeImagesToPdf
        ? "Converting images to PDF"
        : selectedInputPaths.length === 1
          ? "Converting file"
          : "Converting files",
      message: `${selectedInputPaths.length} -> .${outputExt}`,
    });

    try {
      const resultPaths: string[] = [];
      if (shouldMergeImagesToPdf) {
        const firstJob = conversionJobs[0];
        toast.message = `${selectedInputPaths.length} pages -> ${path.basename(firstJob.outputPath)}`;
        resultPaths.push(
          await convertImagesToPdf({
            inputPaths: conversionJobs.map((job) => job.inputPath),
            outputPath: firstJob.outputPath,
            overwrite: values.overwrite,
            tool: firstJob.decision.tool,
          }),
        );
      } else {
        for (const job of conversionJobs) {
          toast.message = `${path.basename(job.inputPath)} -> .${outputExt}`;
          resultPaths.push(
            await convertWithTool({
              inputPath: job.inputPath,
              outputPath: job.outputPath,
              outputExt,
              overwrite: values.overwrite,
              converter: job.decision.kind,
              tool: job.decision.tool,
            }),
          );
        }
      }

      if (selectedDestination === "clipboard" || selectedDestination === "both") {
        if (resultPaths.length === 1) {
          await Clipboard.copy({ file: resultPaths[0] });
        } else {
          await Clipboard.copy(resultPaths.join("\n"));
        }
      }

      toast.style = Toast.Style.Success;
      toast.title =
        selectedDestination === "clipboard"
          ? resultPaths.length === 1
            ? "Copied to clipboard"
            : "Copied output paths"
          : "Conversion complete";
      toast.message = resultPaths.length === 1 ? resultPaths[0] : `${resultPaths.length} files converted`;

      if ((selectedDestination === "save" || selectedDestination === "both") && values.openAfter) {
        await open(resultPaths.length === 1 ? resultPaths[0] : outputDirPath || path.dirname(resultPaths[0]));
      }
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Conversion failed";
      toast.message = error instanceof Error ? error.message : "Unknown error";
    }
  };

  return (
    <Form
      isLoading={detecting || !prefsLoaded}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.ArrowRight} title="Convert" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="input"
        title="Input File"
        canChooseDirectories={false}
        allowMultipleSelection={true}
        value={inputPaths}
        onChange={(value) => {
          setInputPaths(value.map(normalizeInputPath));
        }}
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
