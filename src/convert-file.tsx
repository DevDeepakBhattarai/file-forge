import { Action, ActionPanel, Clipboard, Form, Icon, Toast, open, showToast } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import {
  ConverterDecision,
  OutputDestination,
  buildOutputPath,
  convertWithTool,
  detectConverter,
  getFileExt,
  normalizeExt,
  pickDefaultOutput,
} from "./lib/convert-core";
import { fileURLToPath } from "node:url";

type ConvertFormValues = {
  input: string[];
  outputFormat: string;
  destination: OutputDestination;
  outputDir?: string[];
  overwrite: boolean;
  openAfter: boolean;
};

const normalizeInputPath = (value: string) => (value.startsWith("file://") ? fileURLToPath(value) : value);

export default function Command() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [decision, setDecision] = useState<ConverterDecision | null>(null);
  const [outputFormat, setOutputFormat] = useState<string>("");
  const [destination, setDestination] = useState<OutputDestination>("clipboard");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!inputPath) {
        setDecision(null);
        setOutputFormat("");
        return;
      }
      setLoading(true);
      const resolved = await detectConverter(getFileExt(inputPath));
      if (cancelled) return;
      setDecision(resolved);
      setOutputFormat(resolved?.defaultOutput ?? "");
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [inputPath]);

  const outputFormats = decision?.tool.output ?? [];
  const recommended = useMemo(() => {
    if (!decision) return { recommended: [], all: [] as string[] };
    const recommendedSet = new Set<string>();
    if (decision.defaultOutput) recommendedSet.add(decision.defaultOutput);
    const preferred = pickDefaultOutput(decision.category, outputFormats);
    if (preferred) recommendedSet.add(preferred);
    const recommendedList = Array.from(recommendedSet);
    const remaining = outputFormats.filter((format) => !recommendedSet.has(format));
    return { recommended: recommendedList, all: remaining };
  }, [decision, outputFormats]);

  const handleSubmit = async (values: ConvertFormValues) => {
    const rawInput = values.input?.[0] ?? inputPath;
    if (!rawInput) {
      await showToast(Toast.Style.Failure, "Select a file");
      return;
    }
    const resolvedInput = normalizeInputPath(rawInput);
    let resolvedDecision = decision;
    if (!resolvedDecision || inputPath !== resolvedInput) {
      resolvedDecision = await detectConverter(getFileExt(resolvedInput));
      setDecision(resolvedDecision);
      if (resolvedDecision && !outputFormat) {
        setOutputFormat(resolvedDecision.defaultOutput);
      }
    }
    if (!resolvedDecision) {
      await showToast(Toast.Style.Failure, "No compatible converter found");
      return;
    }
    const outputExt = normalizeExt(values.outputFormat || outputFormat || resolvedDecision.defaultOutput);
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
    const outputDir =
      values.destination === "save" || values.destination === "both"
        ? values.outputDir?.[0] ?? null
        : null;
    const outputPath = buildOutputPath(resolvedInput, outputExt, outputDir, values.destination);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Converting file",
      message: `${resolvedDecision.kind} -> .${outputExt}`,
    });

    try {
      const resultPath = await convertWithTool({
        inputPath: resolvedInput,
        outputPath,
        outputExt,
        overwrite: values.overwrite,
        converter: resolvedDecision.kind,
        tool: resolvedDecision.tool,
      });

      if (values.destination === "clipboard" || values.destination === "both") {
        await Clipboard.copy({ file: resultPath });
      }

      toast.style = Toast.Style.Success;
      toast.title = values.destination === "clipboard" ? "Copied to clipboard" : "Conversion complete";
      toast.message = resultPath;

      if ((values.destination === "save" || values.destination === "both") && values.openAfter) {
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
      isLoading={loading}
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
        allowMultipleSelection={false}
        value={inputPath ? [inputPath] : []}
        onChange={(value) => {
          const next = value?.[0];
          setInputPath(next ? normalizeInputPath(next) : null);
        }}
      />
      {outputFormats.length > 0 ? (
        <Form.Dropdown
          id="outputFormat"
          title="Target Format"
          placeholder="Search formats..."
          value={outputFormat}
          onChange={setOutputFormat}
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
        <Form.TextField id="outputFormat" title="Target Format" value={outputFormat} onChange={setOutputFormat} />
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
        />
      )}
      <Form.Checkbox
        id="overwrite"
        title="Overwrite Existing File"
        label="Overwrite if output already exists"
        defaultValue={false}
      />
      {(destination === "save" || destination === "both") && (
        <Form.Checkbox id="openAfter" title="Open After Convert" label="Open the converted file" defaultValue={true} />
      )}
    </Form>
  );
}
