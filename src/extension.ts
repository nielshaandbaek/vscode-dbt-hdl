// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as cp from "child_process";
import { refreshDiagnostics, subscribeToDocumentChanges } from './diagnostics';

interface TestInfo {
  name?: string;
  filename?: string;
  target?: string;
  params?: string;
  genTestcases?: string;
  tbTestcases?: string;
};

let tests = new WeakMap<vscode.TestItem, TestInfo>();
let processes = new Map<string, cp.ChildProcess>();
let controller: vscode.TestController | undefined = undefined;
let diagnostics: vscode.DiagnosticCollection | undefined = undefined;
let busy: boolean = false;

function createTestInfo(options: TestInfo) {
  let testInfo = { 
    name: "", 
    filename: "", 
    target: "",
    params: "", 
    genTestcases: "", 
    tbTestcases: "" 
  };
  if (options.name) {
    testInfo.name = options.name;
  }
  if (options.filename) {
    testInfo.filename = options.filename;
  }
  if (options.target) {
    testInfo.target = options.target;
  }
  if (options.params) {
    testInfo.params = options.params;
  }
  if (options.genTestcases) {
    testInfo.genTestcases = options.genTestcases;
  }
  if (options.tbTestcases) {
    testInfo.tbTestcases = options.tbTestcases;
  }
  return testInfo;
}

const execTest = (test: vscode.TestItem, cmd: string, cwd: string) =>
    new Promise<string>((resolve, reject) => {
        processes.set(test.id,
          cp.exec(cmd, { cwd: cwd }, (err, stdout, stderr) => {
            if (err) {
                return reject(stdout);
            }
            return resolve(stdout);
          })
        );
    });

const execShell = (cmd: string, cwd: string) =>
    new Promise<string>((resolve, reject) => {
        cp.exec(cmd, { cwd: cwd }, (err, stdout, stderr) => {
            if (err) {
                return reject(stdout);
            }
            return resolve(stdout);
        });
    });

function getDbtArgs(): string {
  const settings = vscode.workspace.getConfiguration();
  const dbtSettings: string[] = [
    "questa-vcom-flags",
    "questa-vlog-flags",
    "questa-vsim-flags",
    "xsim-xsim-flags",
    "xsim-xvlog-flags",
    "xsim-xvhdl-flags",
    "xsim-xelab-debug",
    "questa-access",
    "questa-lint",
  ];

  let dbtArgs: string = "";
  dbtArgs = dbtArgs.concat(` hdl-simulator=${settings.get('dbt-hdl.hdl-simulator')}`);
  
  dbtSettings.forEach( (flag) => {
    if (settings.get(`dbt-hdl.${flag}`) !== "") {
      dbtArgs = dbtArgs.concat(` ${flag}=`+settings.get(`dbt-hdl.${flag}`));
    }
  });
  
  return dbtArgs;
}

async function runHandler(
  shouldDebug: boolean,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
) {
  if (!controller) {
    console.log("No test controller defined!");
    return;
  }

  if (!vscode.workspace.workspaceFolders) {
    console.log("No workspace defined!");
    return;
  }

  const run = controller.createTestRun(request);
  const queue: vscode.TestItem[] = [];
  
  // Loop through all included tests, or all known tests, and add them to our queue
  if (request.include) {
    request.include.forEach(test => queue.push(test));
  } else {
    controller.items.forEach(test => queue.push(test));
  }

  // Arguments will be the same for all tests
  const dbtArgs: string = getDbtArgs();

  // For every test that was queued, try to run it. Call run.passed() or run.failed().
  // The `TestMessage` can contain extra information, like a failing location or
  // a diff output. But here we'll just give it a textual message.
  while (queue.length > 0) {
    const test = queue.pop()!;

    // Find the process and kill it
    if (token.isCancellationRequested) {
      processes.get(test.id)?.kill();
      processes.delete(test.id);
      continue;
    }

    // Skip tests the user asked to exclude
    if (request.exclude?.includes(test)) {
      continue;
    }

    if (test.children.size === 0) {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const start = Date.now();
      const fields = test.id.split(":");
      const target: string = fields[1];
      const settings = vscode.workspace.getConfiguration();
      let runtimeArgs: string = ` -verbosity=${settings.get('dbt-hdl.verbosity')}`;
      
      switch (fields[0]) {
        case "params": {
          runtimeArgs = ` -params=${fields[2]}`;
        }
        case "testCaseGenerator": {
          runtimeArgs = ` -testcases=${fields[2]}`;
          break;
        }
        case "paramsTestCaseGenerator": {
          runtimeArgs = ` -params=${fields[2]} -testcases=${fields[3]}`;
          break;
        }
        case "testBench": {
          runtimeArgs = ` +testcases=${fields[2]}`;
          break;
        }
        case "paramsTestBench": {
          runtimeArgs = ` -params=${fields[2]} +testcases=${fields[3]}`;
          break;
        }
      }
            
      let cmd: string = "";
      if (shouldDebug) {
        cmd = `dbt run ${target}${dbtArgs} :${runtimeArgs}`;
      } else {
        cmd = `dbt test ${target}${dbtArgs} :${runtimeArgs}`;
      }

      run.appendOutput(cmd + "\r\n");
      await execTest(test, cmd, folder)
        .then((result) => {
          refreshDiagnostics(result, diagnostics);
          processes.delete(test.id);
          run.passed(test, Date.now() - start);
          run.appendOutput(String(result).split(/\r\n|\r|\n/).join("\r\n"));
        })
        .catch((result) => {
          const errorsRegExp = new RegExp(/errors:\s*(\d+)\s*,\s*warnings:\s*(\d+)/, 'igm');
          let match;
          let message: vscode.TestMessage = new vscode.TestMessage(result);

          // Get last reported errors
          while ((match = errorsRegExp.exec(result)) !== null) {
            message = new vscode.TestMessage(match[0]);
          }
          
          refreshDiagnostics(result, diagnostics);
          processes.delete(test.id);
          run.failed(test, message, Date.now() - start);
          run.appendOutput(cmd + "\r\n");
          run.appendOutput(String(result).split(/\r\n|\r|\n/).join("\r\n"));
        });
    }

    test.children.forEach(test => queue.push(test));
  }

  // Make sure to end the run after all tests have been executed:
  run.end();
}

function discoverTests(controller: vscode.TestController | undefined, uri: vscode.Uri | undefined) {
  if (!controller) {
    console.log("No controller defined!");
    return;
  }

  if (busy) {
    console.log("dbt already running!");
    return;
  }

  if (uri?.toString().match(/\/BUILD\//) || uri?.toString().match(/\/DEPS\//)) {
    console.log("skipping update!");
    return;
  }

  if (vscode.workspace.workspaceFolders) {
    busy = true;
    const settings = vscode.workspace.getConfiguration();
    const target = settings.get('dbt-hdl.target');
    let folder = vscode.workspace.workspaceFolders[0].uri.fsPath;

    execShell(`dbt build hdl-find-testcases=true hdl-show-testcases-file=true`, folder).then((result) => {
      const lines: Array<string> = result.split(/\r\n|\r|\n/);

      const nameRegExp = new RegExp("(\/\/[^\\s]*\/[^\/]+)\/" + target);
      const paramsRegExp = new RegExp(
        [
            /\s*/,
            /-params=/,
            /([^\s]+)/
        ]
            .map((x) => x.source)
            .join('')
      );

      const testcasesRegExp = new RegExp(
        [
            /\s*/,
            /-testcases=/,
            /([^\s]+)/
        ]
            .map((x) => x.source)
            .join('')
      );

      const testbenchRegExp = new RegExp(
        [
            /\s+/,
            /([^\s]+)/,
            /\s+/,
            /\+testcases=/,
            /([^\s]+)/
        ]
            .map((x) => x.source)
            .join('')
      );

      lines.forEach((line) => {
        let match = nameRegExp.exec(line);
        if (match !== null) {
          let target = match[0];
          let name = target;
          let simulation = controller.createTestItem(`simulation:${target}`, `${name}`);
          let gotParams: boolean = false;

          // Find params
          match = paramsRegExp.exec(line);
          if (match !== null) {         
            match[1].split(/,/).forEach((param) => {
              const test = controller.createTestItem(`params:${param}:${target}`, param);
              simulation.children.add(test);
              tests.set(test, createTestInfo({target: target, name: name, params: param}));
            });
            gotParams = true;
          }

          // Find TestCaseGenerator testcases
          match = testcasesRegExp.exec(line);
          if (match !== null) {
            const testcases: Array<string> = match[1].split(/,/);
            testcases.forEach((testcase) => {
              if (gotParams) {
                simulation.children.forEach(child => {
                  const test = controller.createTestItem(`paramsTestCaseGenerator:${target}:${child.label}:${testcase}`, testcase);
                  child.children.add(test);
                  tests.set(test, createTestInfo({target: target, name: name, params: child.label, genTestcases: testcase}));
                });
              } else {
                const test = controller.createTestItem(`testCaseGenerator:${target}:${testcase}`, testcase);
                simulation.children.add(test);
                tests.set(test, createTestInfo({target: target, name: name, genTestcases: testcase}));
              }
            });
          }

          // Find standard testcases
          match = testbenchRegExp.exec(line);
          if (match) {
            const uri: vscode.Uri = vscode.Uri.file(match[1]);
            const testcases: Array<string> = match[2].split(/,/);
            
            vscode.workspace.openTextDocument(uri).then((doc) => {
              let text = doc.getText();
              testcases.forEach((testcase) => {
                const testCaseRegExp = new RegExp("`" + `TEST_CASE\\s*\\(\\s*"${testcase}"\\s*\\)`);
                let range: vscode.Range | null = null;
                const match: RegExpMatchArray | null = testCaseRegExp.exec(text);
                if (match) {
                  range = new vscode.Range(doc.positionAt(match.index!), doc.positionAt(match.index! + match[0].length));
                }
                if (gotParams) {
                  simulation.children.forEach(child => {
                    const test = controller.createTestItem(`paramsTestBench:${target}:${child.label}:${testcase}`, `${testcase} (${child.label})`, uri);
                    if (range) {
                      test.range = range;
                    }
                    child.children.add(test);
                    tests.set(test, createTestInfo({target: target, name: name, params: child.label, tbTestcases: testcase}));
                  });
                } else {
                  const test = controller.createTestItem(`testBench:${target}:${testcase}`, testcase, uri);
                  if (range) {
                    test.range = range;
                  }
                  simulation.children.add(test);
                  tests.set(test, createTestInfo({target: target, name: name, tbTestcases: testcase}));
                }
              });
            });
          }

          controller.items.add(simulation);
        }
      });
      busy = false;
    }).catch((result) => { busy = false; });
  } 
}

function createWatcher(context: vscode.ExtensionContext, pattern: vscode.GlobPattern) {
  const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  context.subscriptions.push(
    watcher.onDidCreate((uri) => {
      discoverTests(controller, uri);
    })
  );
  context.subscriptions.push(
    watcher.onDidDelete((uri) => {
      discoverTests(controller, uri);
    })
  );
  context.subscriptions.push(
    watcher.onDidChange((uri) => {
      discoverTests(controller, uri);
    })
  );
  context.subscriptions.push(watcher);
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Test controller
  controller = vscode.tests.createTestController(
    'dbt-hdl',
    'Simulation'
  );
  context.subscriptions.push(controller);

  // Diagnostics information
  diagnostics = vscode.languages.createDiagnosticCollection("dbt-hdl");
	context.subscriptions.push(diagnostics);

  subscribeToDocumentChanges(context, diagnostics);

  const runProfile = controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) => {
      runHandler(false, request, token);
    }
  );
  
  const debugProfile = controller.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    (request, token) => {
      runHandler(true, request, token);
    }
  );

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('dbt-hdl.discoverTests', () => {
		discoverTests(controller, undefined);
	});

  // Create file system watchers
  createWatcher(context, '**/BUILD.go');
  createWatcher(context, '**/*.{v,sv,svh}');
 
  // Discover tests on startup
  discoverTests(controller, undefined);

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
  // Kill all running processes
  for (let value of processes.values()) {
    value.kill();
  }
}
