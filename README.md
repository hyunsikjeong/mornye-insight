# Mornye Insight

Mornye Insight is a VS Code extension that provides real-time, interactive graph visualizations of data structure relationships in your codebase.

*Built with vibe coding.*

## Features

* View relationships of data structures based on your cursor position in the editor.
* Simple zoom and pan support (powered by D3 and Graphviz).
* Click on a node to jump to its definition.
* Updates automatically as you navigate through your code.

## Usage

1. Open a workspace containing your source code.
2. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac).
3. Type and execute the command **`Mornye Insight: Show Graph`**.
4. A webview panel will open alongside your editor. As you click on different symbols in your code, the graph will update automatically.

## Installation from Source

If you want to install and use this extension directly from this repository:

1. Clone the repository and navigate into it:
   ```bash
   git clone <repository-url>
   cd ds-insight
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install the VS Code Extension Manager (`vsce`) globally:
   ```bash
   npm install -g @vscode/vsce
   ```
4. Package the extension into a `.vsix` file:
   ```bash
   vsce package
   ```
5. Install the generated `.vsix` file. You can do this via the command line:
   ```bash
   code --install-extension mornye-insight-0.0.1.vsix
   ```
   *Alternatively, in VS Code: Go to the Extensions panel -> Click `...` at the top right -> `Install from VSIX...` and select the file.*

## Tested Languages

- Rust (briefly tested)

## What is Mornye?

Curious about the name? Check out [here](https://wutheringwaves.fandom.com/wiki/Mornye).

## License

This project is licensed under the [MIT License](LICENSE). 
