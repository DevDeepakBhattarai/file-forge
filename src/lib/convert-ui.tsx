import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  open,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConverterDecision,
  OutputDestination,
  buildOutputPath,
  convertWithTool,
  detectConverter,
  formatBytes,
  getFileExt,
  isImageExt,
  normalizeExt,
  pickDefaultOutput,
} from "./convert-core";
import { stat } from "node:fs/promises";

type ConvertFormValues = {
  outputFormat: string;
  destination: OutputDestination;
  outputDir: string[];
  overwrite: boolean;
  openAfter: boolean;
};

export function PreviewScreen(props: {
  inputPath: string;
  sourceLabel: string;
  onReloadClipboard?: () => void;
}) {
  const { inputPath, sourceLabel, onReloadClipboard } = props;
  const [decision, setDecision] = useState<ConverterDecision | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileSize, setFileSize] = useState<string | null>(null);
  const [lastOutputPath, setLastOutputPath] = useState<string | null>(null);
  const [lastOutputExt, setLastOutputExt] = useState<string | null>(null);

  const ext = getFileExt(inputPath);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const resolved = await detectConverter(ext);
      if (cancelled) return;
      setDecision(resolved);
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ext]);

  useEffect(() => {
    let cancelled = false;
    const loadStats = async () => {
      try {
        const stats = await stat(inputPath);
        if (cancelled) return;
        setFileSize(formatBytes(stats.size));
      } catch {
        if (!cancelled) setFileSize(null);
      }
    };
    void loadStats();
    return () => {
      cancelled = true;
    };
  }, [inputPath]);

  const previewMarkdown = useMemo(() => {
    if (!inputPath) {
      return "## No file selected";
    }
    if (isImageExt(ext)) {
      const url = pathToFileURL(inputPath).toString();
      return `![preview](${url})`;
    }
    return `## ${path.basename(inputPath)}\n\n${inputPath}`;
  }, [inputPath, ext]);

  return (
    <Detail
      isLoading={loading}
      markdown={previewMarkdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Source" text={sourceLabel} />
          <Detail.Metadata.Label title="Path" text={inputPath} />
          <Detail.Metadata.Label title="Extension" text={`.${ext}`} />
          {fileSize && <Detail.Metadata.Label title="Size" text={fileSize} />}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Converter" text={decision?.kind ?? "Detecting"} />
          {decision?.defaultOutput && <Detail.Metadata.Label title="Default Output" text={`.${decision.defaultOutput}`} />}
          {lastOutputPath && (
            <>
              <Detail.Metadata.Separator />
              <Detail.Metadata.Label title="Last Output" text={lastOutputPath} />
              {lastOutputExt && <Detail.Metadata.Label title="Last Format" text={`.${lastOutputExt}`} />}
            </>
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {decision && (
            <Action.Push
              icon={Icon.ArrowRight}
              title="Convert"
              target={
                <ConvertForm
                  inputPath={inputPath}
                  decision={decision}
                  outputFormats={decision.tool.output}
                  defaultDestination="clipboard"
                  onConverted={(outputPath, outputExt) => {
                    setLastOutputPath(outputPath);
                    setLastOutputExt(outputExt);
                  }}
                />
              }
            />
          )}
          <Action icon={Icon.CopyClipboard} title="Copy Input Path" onAction={() => Clipboard.copy(inputPath)} />
          <Action icon={Icon.ArrowRight} title="Open Input" onAction={() => open(inputPath)} />
          {onReloadClipboard && <Action icon={Icon.Clipboard} title="Reload Clipboard" onAction={onReloadClipboard} />}
          {lastOutputPath && (
            <ActionPanel.Section>
              <Action
                icon={Icon.CopyClipboard}
                title="Copy Last Output to Clipboard"
                onAction={() => Clipboard.copy({ file: lastOutputPath })}
              />
              <Action icon={Icon.ArrowRight} title="Open Last Output" onAction={() => open(lastOutputPath)} />
            </ActionPanel.Section>
          )}
        </ActionPanel>
      }
    />
  );
}

export function ConvertForm({
  inputPath,
  decision,
  outputFormats,
  defaultDestination,
  onConverted,
}: {
  inputPath: string;
  decision: ConverterDecision;
  outputFormats: string[];
  defaultDestination: OutputDestination;
  onConverted: (outputPath: string, outputExt: string) => void;
}) {
  const [destination, setDestination] = useState<OutputDestination>(defaultDestination);
  const [selectedOutput, setSelectedOutput] = useState<string>(decision.defaultOutput);

  useEffect(() => {
    setSelectedOutput(decision.defaultOutput);
  }, [decision.defaultOutput]);

  const sortedFormats = useMemo(() => {
    const recommended = new Set<string>();
    if (decision.defaultOutput) recommended.add(decision.defaultOutput);
    const preferred = pickDefaultOutput(decision.category, outputFormats);
    if (preferred) recommended.add(preferred);
    const recommendedList = Array.from(recommended);
    const remaining = outputFormats.filter((format) => !recommended.has(format));
    return { recommended: recommendedList, all: remaining };
  }, [decision, outputFormats]);

  const handleSubmit = async (values: ConvertFormValues) => {
    const outputExt = normalizeExt(values.outputFormat || selectedOutput);
    if (!outputExt) {
      await showToast(Toast.Style.Failure, "Choose a target format");
      return;
    }

    if (outputFormats.length > 0 && !outputFormats.includes(outputExt)) {
      await showToast(
        Toast.Style.Failure,
        `.${outputExt} is not supported by ${decision.kind}`,
        'Use "View Supported Formats" to see valid options.',
      );
      return;
    }

    const outputDir =
      values.destination === "save" || values.destination === "both"
        ? values.outputDir?.[0] ?? null
        : null;
    const outputPath = buildOutputPath(inputPath, outputExt, outputDir, values.destination);

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Converting file",
      message: `${decision.kind} -> .${outputExt}`,
    });

    try {
      const resultPath = await convertWithTool({
        inputPath,
        outputPath,
        outputExt,
        overwrite: values.overwrite,
        converter: decision.kind,
        tool: decision.tool,
      });

      if (values.destination === "clipboard" || values.destination === "both") {
        await Clipboard.copy({ file: resultPath });
      }

      toast.style = Toast.Style.Success;
      toast.title = values.destination === "clipboard" ? "Copied to clipboard" : "Conversion complete";
      toast.message = resultPath;

      if (values.openAfter && values.destination !== "clipboard") {
        await open(resultPath);
      }

      onConverted(resultPath, outputExt);
      await popToRoot({ clearSearchBar: true });
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Conversion failed";
      toast.message = error instanceof Error ? error.message : "Unknown error";
    }
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.ArrowRight} title="Convert" onSubmit={handleSubmit} />
          {outputFormats.length > 0 && (
            <Action.Push icon={Icon.List} title="View Supported Formats" target={<FormatsList formats={outputFormats} />} />
          )}
        </ActionPanel>
      }
    >
      <Form.Description title="Input" text={inputPath} />
      {outputFormats.length > 0 ? (
        <Form.Dropdown
          id="outputFormat"
          title="Target Format"
          placeholder="Search formats..."
          value={selectedOutput}
          onChange={setSelectedOutput}
        >
          {sortedFormats.recommended.length > 0 && (
            <Form.Dropdown.Section title="Recommended">
              {sortedFormats.recommended.map((format) => (
                <Form.Dropdown.Item key={format} value={format} title={format} />
              ))}
            </Form.Dropdown.Section>
          )}
          <Form.Dropdown.Section title="All Formats">
            {sortedFormats.all.map((format) => (
              <Form.Dropdown.Item key={format} value={format} title={format} />
            ))}
          </Form.Dropdown.Section>
        </Form.Dropdown>
      ) : (
        <Form.TextField id="outputFormat" title="Target Format" defaultValue={decision.defaultOutput} placeholder="e.g. png, mp3, pdf" />
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
      <Form.Checkbox id="overwrite" title="Overwrite Existing File" label="Overwrite if output already exists" defaultValue={false} />
      {(destination === "save" || destination === "both") && (
        <Form.Checkbox id="openAfter" title="Open After Convert" label="Open the converted file" defaultValue={true} />
      )}
    </Form>
  );
}

export function FormatsList(props: { formats: string[] }) {
  return (
    <List searchBarPlaceholder="Filter formats">
      {props.formats.map((format) => (
        <List.Item key={format} title={format} />
      ))}
    </List>
  );
}
