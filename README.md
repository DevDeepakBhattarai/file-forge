# File Forge

A powerful file conversion extension for Raycast. Convert images, audio, video, and documents between various formats directly from your keyboard.

## Features

- **Convert File**: Pick a file and convert it to your desired format.
- **Convert Clipboard File**: Detects file paths or images in your clipboard and converts them.
- **Smart Detection**: Automatically suggests compatible output formats based on the input file type.
- **Bulk Output**: Save to disk, copy to clipboard, or both.

## Supported Formats

File Forge relies on powerful CLI tools to handle conversions. Support depends on the installed tools:

- **Images** (requires **ImageMagick**):
  - Inputs: `png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`, `svg`, `ico`, `tiff`, and more.
  - Outputs: `png`, `jpg`, `webp`, etc.
- **Audio** (requires **FFmpeg**):
  - Inputs: `mp3`, `wav`, `aac`, `flac`, `ogg`, `m4a`, etc.
  - Outputs: `wav`, `mp3`, `aac`.
- **Video** (requires **FFmpeg**):
  - Inputs: `mp4`, `mov`, `mkv`, `webm`, `avi`, etc.
  - Outputs: `mp4`, `mov`, `mkv`.
- **Documents** (requires **Pandoc** or **LibreOffice**):
  - **Pandoc**: Markdown, HTML, Org-mode, etc.
  - **LibreOffice**: `docx`, `xlsx`, `pptx`, `odt` to `pdf`, `pdf` to `txt`, etc.

## Prerequisites

To use File Forge, you must have the underlying conversion tools installed on your system. You only need to install the tools for the formats you want to convert.

### macOS (via Homebrew)

```bash
brew install imagemagick ffmpeg pandoc --cask libreoffice
```

### Windows (via Winget or Chocolatey)

```powershell
winget install ImageMagick.ImageMagick FFmpeg Pandoc.Pandoc LibreOffice.LibreOffice
```

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/deepak_bhattarai/file-forge.git
   cd file-forge
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the extension**

   ```bash
   npm run build
   ```

4. **Import into Raycast**
   - Open Raycast.
   - Run the **Import Extension** command.
   - Select the `file-forge` folder.

## Configuration

If Raycast cannot find your installed tools (e.g., if they are not in your system `PATH`), you can specify the absolute paths in the extension **Preferences**:

- **ImageMagick Path**: e.g., `/opt/homebrew/bin/magick` or `C:\Program Files\ImageMagick\magick.exe`
- **FFmpeg Path**: e.g., `/opt/homebrew/bin/ffmpeg`
- **Pandoc Path**: e.g., `/opt/homebrew/bin/pandoc`
- **LibreOffice Path**: e.g., `/Applications/LibreOffice.app/Contents/MacOS/soffice` or `C:\Program Files\LibreOffice\program\soffice.exe`

## Development

To run the extension in development mode (hot-reloading):

```bash
npm run dev
```

## License

MIT
