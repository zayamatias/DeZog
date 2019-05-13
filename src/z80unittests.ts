import * as vscode from 'vscode';
import * as assert from 'assert';
import { EmulDebugAdapter } from './emuldebugadapter';
import { Emulator } from './emulatorfactory';
import { Z80Registers } from './z80registers';
import { Labels } from './labels';
import { EmulatorBreakpoint } from './emulator';
//import { zSocket } from './zesaruxSocket'; // TODO: remove
import { GenericWatchpoint } from './genericwatchpoint';
import { LabelsClass } from './labels';
import { Settings } from './settings';
import * as jsonc from 'jsonc-parser';
import { readFileSync } from 'fs';
import { Utility } from './utility';




/// Some definitions for colors.
enum Color {
	Reset = "\x1b[0m",
	Bright = "\x1b[1m",
	Dim = "\x1b[2m",
	Underscore = "\x1b[4m",
	Blink = "\x1b[5m",
	Reverse = "\x1b[7m",
	Hidden = "\x1b[8m",

	FgBlack = "\x1b[30m",
	FgRed = "\x1b[31m",
	FgGreen = "\x1b[32m",
	FgYellow = "\x1b[33m",
	FgBlue = "\x1b[34m",
	FgMagenta = "\x1b[35m",
	FgCyan = "\x1b[36m",
	FgWhite = "\x1b[37m",

	BgBlack = "\x1b[40m",
	BgRed = "\x1b[41m",
	BgGreen = "\x1b[42m",
	BgYellow = "\x1b[43m",
	BgBlue = "\x1b[44m",
	BgMagenta = "\x1b[45m",
	BgCyan = "\x1b[46m",
	BgWhite = "\x1b[47m",
}

/**
 * Colorize a string
 * @param color The color, e.g. '\x1b[36m' for cyan, see https://coderwall.com/p/yphywg/printing-colorful-text-in-terminal-when-run-node-js-script.
 * @param text The strign to colorize.
 */
function colorize(color: string, text: string): string {
	return color + text + '\x1b[0m';
}


/**
 * Enumeration for the returned test case pass or failure.
 */
enum TestCaseResult {
	OK = 0,
	FAILED = 1,
	TIMEOUT = 2,
	CANCELLED = 3,	// Testcases have been cancelled, e.g. manually or the connection might have been lost or whatever.
}

/**
 * This class takes care of executing the unit tests.
 * It basically
 * 1. Reads the list file to find the unit test labels.
 * 2. Loads the binary into the emulator.
 * 3. Manipulates memory and PC register to call a specific unit test.
 * 4. Loops over all found unit tests.
 */
export class Z80UnitTests {

	/// This array will contain the names of all UT testcases.
	protected static utLabels: Array<string>;

	/// This array will contain the names of the test cases that should be run.
	protected static partialUtLabels: Array<string>|undefined;

	/// A map for the test case labels and their resolve functions. The resolve
	/// function is called when the test cases has been executed.
	/// result:
	///   0 = passed
	///   1 = failed
	///   2 = timeout
	protected static testCaseMap = new Map<string, (result: number) => void>();

	/// The unit test initialization routine. The user has to provide
	/// it and the label.
	protected static addrInit: number;

	/// The start address of the unit test wrapper.
	/// This is called to start the unit test.
	protected static addrTestWrapper: number;

	/// Here is the address of the unit test written.
	protected static addrCall: number;

	/// At the end of the test this address is reached on success.
	protected static addrTestReadySuccess: number;

	/// At the end of the test this address is reached on failure.
	protected static addrTestReadyFailure: number;

	/// Is filled with the summary of tests and results.
	protected static outputSummary: string;

	/// Counts number of failed and total testcases.
	protected static countFailed: number;
	protected static countExecuted: number;

	/// Is set if the current  testcase fails.
	protected static currentFail: boolean;

	/// The handle for the timeout.
	protected static timeoutHandle;

	/// Debug mode or run mode.
	protected static debug = false;


	/**
	 * Execute all unit tests.
	 */
	public static runAllUnitTests() {
		// All testcases
		Z80UnitTests.partialUtLabels = undefined;
		// Start
		Z80UnitTests.runTests();
	}


	/**
	 * Execute some unit tests.
	 */
	public static runUnitTests() {
		// Get list of test case labels
		Z80UnitTests.partialUtLabels = [];
		for(const [tcLabel,] of Z80UnitTests.testCaseMap)
			Z80UnitTests.partialUtLabels.push(tcLabel);
		// Start
		Z80UnitTests.runTests();
	}


	/**
	 * Start the unit tests, either partial or full.
	 */
	protected static runTests() {
		try {
			// Get unit test launch config
			const configuration = Z80UnitTests.getUnitTestsLaunchConfig();
			const configName: string = configuration.name;

			// Start debugger
			const success = EmulDebugAdapter.unitTests(configName, this.handleDebugAdapter);
			if(!success) {
				vscode.window.showErrorMessage("Couldn't start unit tests. Is maybe a debug session active?");
			}
		}
		catch(e) {
			vscode.window.showErrorMessage(e.message);
		}
	}


	/**
	 * Clears the map of testcases.
	 * Is called at first when starting (partial) unit testcases.
	 */
	public static clearTestCaseList(){
		// Clear map
		Z80UnitTests.testCaseMap.clear();
	}


	/**
	 * "Executes" one unit test case.
	 * The test case is just remembered and executed later.
	 * Whenever the test case is executed the result is passed in the promise.
	 * @param tcLabels An array with the unit test case labels.
	 */
	public static execUnitTestCase(tcLabel: string): Promise<number> {
		// Create promise.
		const promise = new Promise<number>((resolve) => {
			// Remember its resolve function.
			Z80UnitTests.testCaseMap.set(tcLabel, resolve);
		});
		// Return promise.
		return promise;
	}


	/**
	 * Returns the unit tests launch configuration. I.e. the configuration
	 * from .vscode/launch.json with property unitTests set to true.
	 */
	protected static getUnitTestsLaunchConfig(): any {
		const launchJsonFile = ".vscode/launch.json";
		const launchPath = Utility.getAbsFilePath(launchJsonFile);
		const launchData = readFileSync(launchPath, 'utf8');
		const parseErrors: jsonc.ParseError[] = [];
		const launch = jsonc.parse(launchData, parseErrors, {allowTrailingComma: true});

		// Check for error
		if(parseErrors.length > 0) {
			// Error
			throw Error("Parse error while reading " + launchJsonFile + ".");
		}

		// Find the right configuration
		let configuration;
		for(const config of launch.configurations) {
			if (config.unitTests) {
				// Check if there is already unit test configuration:
				// Only one is allowed.
				if(configuration)
					throw Error("More than one unit test launch configuration found. Only one is allowed.");
				configuration = config;
			}
		}


		// Load user list and labels files
		if(!configuration) {
			// No configuration found, Error
			throw Error('No unit test configuration found in ' + launchJsonFile + '.');
		}

		// Load user list and labels files
		const listFiles = configuration.listFiles;
		if(!listFiles) {
			// No list file given
			// Error
			throw Error('no list file given in unit test configuration.');
		}

		return configuration;
	}


	/**
	 * Retrieves a list of strings with the labels of all unit tests.
	 * @returns A list of strings with the label names of the unit tests or a single string with the error text.
	 */
	public static getAllUnitTests(): Promise<string[]> {
		return new Promise<string[]>((resolve, reject) => {
			try {
				const configuration = Z80UnitTests.getUnitTestsLaunchConfig();

				const labels = new LabelsClass();
				const listFiles = configuration.listFiles;
				for(const listFile of listFiles) {
					const file = {
						path: Utility.getAbsFilePath(listFile.path),
						mainFile: listFile.mainFile,
						srcDirs: listFile.srcDirs || [""],
						filter: listFile.filter,
						asm: listFile.asm || "sjasmplus",
						addOffset: listFile.addOffset || 0
					};
					labels.loadAsmListFile(file.path, file.mainFile, file.srcDirs, file.filter, file.asm, file.addOffset);
				}

				// Get the unit test labels
				const utLabels = Z80UnitTests.getAllUtLabels(labels);
				resolve(utLabels);
			}
			catch(e) {
				// Error
				reject(e.message || "Unknown error.");
			}
		});
	}


	/**
	 * Handles the states of the debug adapter. Will be called after setup
	 * @param debugAdapter The debug adpater.
	 */
	protected static handleDebugAdapter(debugAdapter: EmulDebugAdapter) {
		debugAdapter.on('initialized', () => {
			try {
				//assert(EmulDebugAdapter.state == DbgAdaperState.UNITTEST);
				// The Z80 binary has been loaded.
				// The debugger stopped before starting the program.
				// Now read all the unit tests.
				Z80UnitTests.outputSummary = '';
				Z80UnitTests.countFailed = 0;
				Z80UnitTests.countExecuted = 0;
				Z80UnitTests.timeoutHandle = undefined;

				// Get the unit test code
				Z80UnitTests.addrInit = Z80UnitTests.getNumberForLabel("UNITTEST_INIT");
				Z80UnitTests.addrTestWrapper = Z80UnitTests.getNumberForLabel("UNITTEST_TEST_WRAPPER");
				Z80UnitTests.addrCall = Z80UnitTests.getNumberForLabel("UNITTEST_CALL_ADDR");
				Z80UnitTests.addrCall ++;
				Z80UnitTests.addrTestReadySuccess = Z80UnitTests.getNumberForLabel("UNITTEST_TEST_READY_SUCCESS");
				Z80UnitTests.addrTestReadyFailure = Z80UnitTests.getNumberForLabel("UNITTEST_TEST_READY_FAILURE_BREAKPOINT");
				const stackMinWatchpoint = Z80UnitTests.getNumberForLabel("UNITTEST_MIN_STACK_GUARD");
				const stackMaxWatchpoint = Z80UnitTests.getNumberForLabel("UNITTEST_MAX_STACK_GUARD");

				// Labels not yet known.
				Z80UnitTests.utLabels = undefined as unknown as Array<string>;

				// Success and failure breakpoints
				const successBp: EmulatorBreakpoint = { bpId: 0, filePath: '', lineNr: -1, address: Z80UnitTests.addrTestReadySuccess, condition: '',	log: undefined };
				Emulator.setBreakpoint(successBp);
				const failureBp: EmulatorBreakpoint = { bpId: 0, filePath: '', lineNr: -1, address: Z80UnitTests.addrTestReadyFailure, condition: '',	log: undefined };
				Emulator.setBreakpoint(failureBp);

				// Stack watchpoints
				const stackMinWp: GenericWatchpoint = { address: stackMinWatchpoint, size: 2, access: 'rw', conditions: '' };
				const stackMaxWp: GenericWatchpoint = { address: stackMaxWatchpoint, size: 2, access: 'rw', conditions: '' };
				Emulator.setWatchpoints([stackMinWp, stackMaxWp]);

				// Start unit tests after a short while
				Z80UnitTests.startUnitTestsWhenQuiet(debugAdapter);
			}
			catch(e) {
				Z80UnitTests.stopUnitTests(debugAdapter, e.message);
			}
		});

		debugAdapter.on('break', () => {
			// The program was run and a break occured.
			// Get current pc
			Emulator.getRegisters(data => {
				// Parse the PC value
				const pc = Z80Registers.parsePC(data);
				//const sp = Z80Registers.parseSP(data);
				// Check if testcase was successfull
				Z80UnitTests.checkUnitTest(debugAdapter, pc);
				// Otherwise another break- or watchpoint was hit or the user stepped manually.
			});
		});
	}


	/**
	 * Returns the address for a label. Checks it and throws an error if it does not exist.
	 * @param label The label eg. "UNITTEST_TEST_WRAPPER"
	 * @returns An address.
	 */
	protected static getNumberForLabel(label: string): number {
		const addr = Labels.getNumberForLabel(label) as number;
		if(!addr) {
			throw Error("Couldn't find the unit test wrapper (" + label + "). Did you forget to use the macro?");
		}
		return addr;
	}


	/**
	 * Waits a few 100ms until traffic is quiet on the zSocket interface.
	 * The problem that is solved here:
	 * After starting the vscode sends the source file breakpoints.
	 * But there is no signal to tell when all are sent.
	 * If we don't wait we would miss a few and we wouldn't break.
	 * @param da The debug emulator.
	 */
	protected static startUnitTestsWhenQuiet(da: EmulDebugAdapter) {
		da.executeAfterBeingQuietFor(300, () => {
			// Load the initial unit test routine (provided by the user)
			Z80UnitTests.execAddr(Z80UnitTests.addrInit, da);
		});
	}


	/**
	 * Executes the sub routine at 'addr'.
	 * Used to call the unit test initialization subroutine and the unit
	 * tests.
	 * @param da The debug adapter.
	 */
	protected static execAddr(address: number, da: EmulDebugAdapter) {
		// Set memory values to test case address.
		const callAddr = new Uint8Array([ address & 0xFF, address >> 8]);
		Emulator.writeMemoryDump(this.addrCall, callAddr, () => {
			// Set PC
			Emulator.setProgramCounter(this.addrTestWrapper, () => {
				// Run
				if(Z80UnitTests.utLabels)
					Z80UnitTests.dbgOutput('UnitTest: ' + Z80UnitTests.utLabels[0] + ' da.emulatorContinue()');
				// Continue
				da.emulatorContinue();
				// With vscode UI
				if(Z80UnitTests.debug)
					da.sendEventContinued()
			});
		});
	}


	/**
	 * Executes the next test case.
	 * @param da The debug adapter.
	 */
	protected static nextUnitTest(da: EmulDebugAdapter) {
		// Increase count
		Z80UnitTests.countExecuted ++;
		Z80UnitTests.currentFail = false;
		// Get Unit Test label
		const label = Z80UnitTests.utLabels[0];
		// Calculate address
		const address = Labels.getNumberForLabel(label) as number;
		assert(address);

		// Set timeout
		if(!Z80UnitTests.debug) {
			clearTimeout(Z80UnitTests.timeoutHandle);
			Z80UnitTests.timeoutHandle = setTimeout(() => {
				// Clear timeout
				clearTimeout(Z80UnitTests.timeoutHandle);
				Z80UnitTests.timeoutHandle = undefined;
				// Failure: Timeout. Send a break.
				Emulator.pause();
			}, 1000*Settings.launch.unittestTimeOut);
		}

		// Start at test case address.
		Z80UnitTests.dbgOutput('TestCase ' + label + '(0x' + address.toString(16) + ') started.');
		Z80UnitTests.execAddr(address, da);
	}


	/**
	 * Checks if the testcase was OK or a fail.
	 * Or undetermined.
	 * @param da The debug adapter.
	 * @param pc The program counter to check.
	 */
	protected static checkUnitTest(da: EmulDebugAdapter, pc: number) {
		// Check if it was a timeout
		const timeoutFailure = (Z80UnitTests.timeoutHandle == undefined);
		if(Z80UnitTests.timeoutHandle) {
			// Clear timeout
			clearTimeout(Z80UnitTests.timeoutHandle);
			Z80UnitTests.timeoutHandle = undefined;
		}

		// Check if test case ended successfully or not
		if(pc != this.addrTestReadySuccess
			&& pc != this.addrTestReadyFailure) {
			// Undetermined. Testcase not ended yet.
			//Z80UnitTests.dbgOutput('UnitTest: checkUnitTest: user break');
			// Count failure
			if(!Z80UnitTests.currentFail) {
				// Count only once
				Z80UnitTests.currentFail = true;
				Z80UnitTests.countFailed ++;
			}
			// Check if in debug or run mode.
			if(Z80UnitTests.debug) {
				// In debug mode: Send break to give vscode control
				da.sendEventBreakAndUpdate();
				return;
			}
		}

		// Check if this was the init routine that is started
		// before any test case:
		if(!Z80UnitTests.utLabels) {
			if(Z80UnitTests.partialUtLabels) {
				// Use the passed list
				Z80UnitTests.utLabels = Z80UnitTests.partialUtLabels;
			}
			else {
				// Get all labels that look like: 'UT_xxx'
				Z80UnitTests.utLabels = Z80UnitTests.getAllUtLabels(Labels);
			}
			// Error check
			if(Z80UnitTests.utLabels.length == 0) {
				// No unit tests found -> disconnect
				Z80UnitTests.stopUnitTests(da, "Couldn't start unit tests. No unit tests found. Unit test labels should start with 'UT_'.");
				return;
			}
			// Start unit tests
			Z80UnitTests.nextUnitTest(da);
			return;
		}

		// Was a real test case.

		// OK or failure
		const tcSuccess = (pc == Z80UnitTests.addrTestReadySuccess);

		// Count failure
		if(!tcSuccess) {
			if(!Z80UnitTests.currentFail) {
				// Count only once
				Z80UnitTests.currentFail = true;
				Z80UnitTests.countFailed ++;
			}
		}

		// In debug mode do break after one step. The step is required to put the PC at the right place.
		const label = Z80UnitTests.utLabels[0];
		if(Z80UnitTests.debug && !tcSuccess) {
			// Do a step
			Z80UnitTests.dbgOutput('UnitTest: ' + label + '  da.emulatorStepOver()');
			da.emulatorStepOver();
			return;
		}

		// Determine test case result.
		let tcResult: TestCaseResult = TestCaseResult.TIMEOUT;
		if(!timeoutFailure) {
			// No timeout
			tcResult = (Z80UnitTests.currentFail) ? TestCaseResult.FAILED : TestCaseResult.OK;
		}

		// Send result to calling extension (i.e. test adapter)
		const resolveFunction = Z80UnitTests.testCaseMap.get(label);
		if(resolveFunction) {
			// Inform calling party
			resolveFunction(tcResult);
			// Delete from map
			Z80UnitTests.testCaseMap.delete(label);
		}

		// Print test case name, address and result.
		let tcResultStr;
		switch(tcResult) {
			case TestCaseResult.OK: tcResultStr = colorize(Color.FgGreen, 'OK'); break;
			case TestCaseResult.FAILED: tcResultStr = colorize(Color.FgRed, 'Fail'); break;
			case TestCaseResult.TIMEOUT: tcResultStr = colorize(Color.FgRed, 'Fail (timeout, ' + Settings.launch.unittestTimeOut + 's)'); break;
		}

		const addr = Labels.getNumberForLabel(label) || 0;
		const outTxt = label + ' (0x' + addr.toString(16) + '):\t' + tcResultStr;
		Z80UnitTests.dbgOutput(outTxt);
		Z80UnitTests.outputSummary += outTxt + '\n';

		// Next unit test
		Z80UnitTests.utLabels.shift();
		if(Z80UnitTests.utLabels.length == 0) {
			// End the unit tests
			Z80UnitTests.dbgOutput("All tests ready.");
			Z80UnitTests.printSummary();
			Z80UnitTests.stopUnitTests(da);
			return;
		}
		Z80UnitTests.nextUnitTest(da);
	}


	/**
	 * Returns all labels that start with "UT_".
	 * @returns An array with label names.
	 */
	protected static getAllUtLabels(labels: LabelsClass): string[] {
		const utLabels = labels.getLabelsForRegEx('.*\\bUT_\\w*$', '');	// case sensitive
		return utLabels;
	}


	/**
	 * Sends a CANCELLED for all still open running testcases
	 * to the caller (i.e. the test case adapter).
	 */
	protected static CancelAllRemaingResults() {
		for(const [, resolveFunc] of Z80UnitTests.testCaseMap) {
			// Return an error code
			resolveFunc(TestCaseResult.CANCELLED);
		}
		Z80UnitTests.testCaseMap.clear();
	}


	/**
	 * Stops the unit tests.
	 * @param errMessage If set an optional error message is shown.
	 */
	protected static stopUnitTests(debugAdapter: EmulDebugAdapter, errMessage?: string) {
		// Clear timeout
		clearTimeout(Z80UnitTests.timeoutHandle);
		Z80UnitTests.timeoutHandle = undefined;
		// Clear remianing testcases
		Z80UnitTests.CancelAllRemaingResults();
		// Exit
		debugAdapter.exit(errMessage);
	}


	/**
	 * Prints out text to the clients debug console.
	 * @param txt The text to print.
	 */
	protected static dbgOutput(txt: string) {
		// Savety check
		if(!vscode.debug.activeDebugConsole)
			return;

		// Only newline?
		if(!txt)
			txt = '';
		vscode.debug.activeDebugConsole.appendLine('UNITTEST: ' + txt);
		//zSocket.logSocket.log('UNITTEST: ' + txt);
	}


	/**
	 * Prints out a test case and result summary.
	 */
	protected static printSummary() {
		// Savety check
		if(!vscode.debug.activeDebugConsole)
			return;

		// Print summary
		const emphasize = '+-------------------------------------------------';
		vscode.debug.activeDebugConsole.appendLine('');
		vscode.debug.activeDebugConsole.appendLine(emphasize);
		vscode.debug.activeDebugConsole.appendLine('UNITTEST SUMMARY:\n\n');
		vscode.debug.activeDebugConsole.appendLine(Z80UnitTests.outputSummary);

		const color = (Z80UnitTests.countFailed>0) ? Color.FgRed : Color.FgGreen;
		const countPassed = Z80UnitTests.countExecuted - Z80UnitTests.countFailed;
		vscode.debug.activeDebugConsole.appendLine('');
		vscode.debug.activeDebugConsole.appendLine('Total testcases: ' + Z80UnitTests.countExecuted);
		vscode.debug.activeDebugConsole.appendLine('Passed testcases: ' + countPassed);
		vscode.debug.activeDebugConsole.appendLine(colorize(color, 'Failed testcases: ' + Z80UnitTests.countFailed));
		vscode.debug.activeDebugConsole.appendLine(colorize(color, Math.round(100*countPassed/Z80UnitTests.countExecuted) + '% passed.'));
		vscode.debug.activeDebugConsole.appendLine('');

		vscode.debug.activeDebugConsole.appendLine(emphasize);
	}

}
