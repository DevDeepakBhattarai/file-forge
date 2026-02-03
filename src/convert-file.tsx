import { Action, ActionPanel, Form, Icon, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { PreviewScreen } from "./lib/convert-ui";

type InputFormValues = { input: string[] };

function InputForm({ onSelect }: { onSelect: (filePath: string) => void }) {
  const handleSubmit = async (values: InputFormValues) => {
    if (!values.input || values.input.length === 0) {
      await showToast(Toast.Style.Failure, "Select a file");
      return;
    }
    onSelect(values.input[0]);
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Check} title="Use File" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="input"
        title="Input File"
        canChooseDirectories={false}
        allowMultipleSelection={false}
      />
    </Form>
  );
}

export default function Command() {
  const [inputPath, setInputPath] = useState<string | null>(null);

  if (!inputPath) {
    return <InputForm onSelect={setInputPath} />;
  }

  return <PreviewScreen inputPath={inputPath} sourceLabel="File Picker" />;
}
