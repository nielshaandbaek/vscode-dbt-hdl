// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as cp from "child_process";

let processes = new Map<string, cp.ChildProcess>();

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

async function runHandler(
  shouldDebug: boolean,
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
) {
  const run = controller.createTestRun(request);
  const queue: vscode.TestItem[] = [];
  const settings = vscode.workspace.getConfiguration();
  let dbtArgs: string = "";
  dbtArgs = dbtArgs.concat(`hdl-simulator=${settings.get('dbt-hdl.hdl-simulator')}`);

  // Loop through all included tests, or all known tests, and add them to our queue
  if (request.include) {
    request.include.forEach(test => queue.push(test));
  } else {
    controller.items.forEach(test => queue.push(test));
  }

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

    if ((test.children.size === 0) && (vscode.workspace.workspaceFolders !== undefined)) {
      const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const start = Date.now();
      const fields = test.id.split(":");
      const target: string = fields[1];
      let runtimeArgs: string = "";
      
      switch (fields[0]) {
        case "params": {
          runtimeArgs = `-params=${fields[2]}`;
        }
        case "testCaseGenerator": {
          runtimeArgs = `-testcases=${fields[2]}`;
          break;
        }
        case "paramsTestCaseGenerator": {
          runtimeArgs = `-params=${fields[2]} -testcases=${fields[3]}`;
          break;
        }
        case "testBench": {
          runtimeArgs = `+testcases=${fields[2]}`;
          break;
        }
        case "paramsTestBench": {
          runtimeArgs = `-params=${fields[2]} +testcases=${fields[3]}`;
          break;
        }
      }
      
      runtimeArgs = `-verbosity=${settings.get('dbt-hdl.verbosity')} ${runtimeArgs}`;
      
      let cmd: string = "";
      if (shouldDebug) {
        cmd = `dbt run ${target} ${dbtArgs} : ${runtimeArgs}`;
      } else {
        cmd = `dbt test ${target} ${dbtArgs} : ${runtimeArgs}`;
      }

      await execTest(test, cmd, folder)
        .then((result) => {
          processes.delete(test.id);
          run.passed(test, Date.now() - start);
          run.appendOutput(String(result).split(/\r\n|\r|\n/).join("\r\n"));
        })
        .catch((result) => {
          const errorsRegExp = new RegExp(/errors:\s*(\d+)\s*,\s*warnings:\s*(\d+)/, 'i');
          const match = errorsRegExp.exec(result);
          let message: vscode.TestMessage;
          if (match !== null) {
            message = new vscode.TestMessage(match[0]);
          } else {
            message = new vscode.TestMessage(result);
          }
          
          processes.delete(test.id);
          run.failed(test, message, Date.now() - start);
          run.appendOutput(String(result).split(/\r\n|\r|\n/).join("\r\n"));
        });
    }

    test.children.forEach(test => queue.push(test));
  }

  // Make sure to end the run after all tests have been executed:
  run.end();
}

function discoverTests(controller: vscode.TestController) {
  if(vscode.workspace.workspaceFolders !== undefined) {
    const settings = vscode.workspace.getConfiguration();
    const target = settings.get('dbt-hdl.target');
    let folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    execShell(`dbt build hdl-find-testcases=true hdl-show-testcases-file=true`, folder).then((result) => {
      const lines: Array<string> = result.split(/\r\n|\r|\n/);

      const nameRegExp = new RegExp("^\\s*\/\/.*\/([^\/]+)\/" + target);
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

      const testcaseRegExp = new RegExp(
        [
          /(?<=^\s*)/,
          /`(?<type>TEST_CASE)\s*/,
          /\(\s*"(?<name>[^"]+)"\s*\)/,
        ]
          .map((x) => x.source)
          .join(''),
        'mg'
      );

      lines.forEach((line) => {
        let match = nameRegExp.exec(line);
        if (match !== null) {
          let target = match[0];
          let name = match[1];
          let simulation = controller.createTestItem(`simulation:${target}`, `${name}/${settings.get("dbt-hdl.target")}`);
          let gotParams: boolean = false;

          // Find params
          match = paramsRegExp.exec(line);
          if (match !== null) {         
            match[1].split(/,/).forEach((param) => {
              const test = controller.createTestItem(`params:${param}:${target}`, param);
              simulation.children.add(test);
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
                });
              } else {
                simulation.children.add(controller.createTestItem(`testCaseGenerator:${target}:${testcase}`, testcase));
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
                  });
                } else {
                  const test = controller.createTestItem(`testBench:${target}:${testcase}`, testcase, uri);
                  if (range) {
                    test.range = range;
                  }
                  simulation.children.add(test);
                }
              });
            });
          }

          controller.items.add(simulation);
        }
      });
    });
  } 
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Test controller
  const controller = vscode.tests.createTestController(
    'dbt-hdl',
    'Simulation'
  );
  context.subscriptions.push(controller);

  const runProfile = controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) => {
      runHandler(false, controller, request, token);
    }
  );
  
  const debugProfile = controller.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    (request, token) => {
      runHandler(true, controller, request, token);
    }
  );

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('dbt-hdl.discoverTests', () => {
		discoverTests(controller);
	});

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{go,sv}', false, false, false);
  context.subscriptions.push(
    watcher.onDidCreate((uri) => {
      discoverTests(controller);
    })
  );
  context.subscriptions.push(
    watcher.onDidDelete((uri) => {
      discoverTests(controller);
    })
  );
  context.subscriptions.push(
    watcher.onDidChange((uri) => {
      discoverTests(controller);
    })
  );
  context.subscriptions.push(watcher);

  // Discover tests on startup
  discoverTests(controller);

	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
  // Kill all running processes
  for (let value of processes.values()) {
    value.kill();
  }
}
