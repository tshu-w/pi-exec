import { join } from "node:path";
import ts from "typescript";
import { findPiPackage, piCompilerOptions, projectRoot } from "./pi-install.mjs";

const configPath = join(projectRoot, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const host = { getCanonicalFileName: (file) => file, getCurrentDirectory: () => projectRoot, getNewLine: () => ts.sys.newLine };
let diagnostics = config.error ? [config.error] : [];
if (!config.error) {
	const parsed = ts.parseJsonConfigFileContent({ ...config.config, compilerOptions: { ...config.config.compilerOptions, ...piCompilerOptions(findPiPackage()) } }, ts.sys, projectRoot);
	diagnostics = parsed.errors;
	if (!diagnostics.length) diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options));
}
if (diagnostics.length) {
	process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
	process.exitCode = 1;
}
