import { Action, ActionPanel, Detail, Icon, Toast, showToast } from "@raycast/api";
import { useEffect, useState } from "react";
import { readClipboardFile } from "./lib/convert-core";
import { PreviewScreen } from "./lib/convert-ui";

export default function Command() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadClipboard = async () => {
    setLoading(true);
    const file = await readClipboardFile();
    setInputPath(file);
    setLoading(false);
  };

  useEffect(() => {
    void loadClipboard();
  }, []);

  if (!inputPath) {
    return (
      <Detail
        isLoading={loading}
        markdown="## No file in clipboard\n\nCopy a file in Explorer/Finder and try again."
        actions={
          <ActionPanel>
            <Action icon={Icon.Clipboard} title="Reload Clipboard" onAction={loadClipboard} />
            <Action
              icon={Icon.Info}
              title="Show Help"
              onAction={() => showToast(Toast.Style.Animated, "Tip", "Copy a file so Raycast can read it.")}
            />
          </ActionPanel>
        }
      />
    );
  }

  return <PreviewScreen inputPath={inputPath} sourceLabel="Clipboard" onReloadClipboard={loadClipboard} />;
}
