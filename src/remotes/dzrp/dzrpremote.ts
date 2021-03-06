import * as fs from 'fs';
import {RemoteBase, RemoteBreakpoint, BREAK_REASON_NUMBER, MemoryBank} from '../remotebase';
import {GenericWatchpoint, GenericBreakpoint} from '../../genericwatchpoint';
import {Z80RegistersClass, Z80_REG, Z80Registers} from '../z80registers';
import {MemBank16k} from './membank16k';
import {SnaFile} from './snafile';
import {NexFile} from './nexfile';
import {Settings} from '../../settings';
import {Utility} from '../../misc/utility';
import * as path from 'path';
import {Remote} from '../remotefactory';
import {Labels} from '../../labels';
import {ZxMemory} from '../zxsimulator/zxmemory';
import {gzip, ungzip} from 'node-gzip';
import {TimeWait} from '../../misc/timewait';



// The current implemented version of the protocol.
export const DZRP_VERSION=[1, 0, 0];


/**
 * The DZP commands and responses.
 * The response contains the command with the bit 7 set.
 */
export enum DZRP {
	CMD_INIT=1,
	CMD_GET_REGISTERS=2,
	CMD_SET_REGISTER=3,
	CMD_WRITE_BANK=4,
	CMD_CONTINUE=5,
	CMD_PAUSE=6,

	CMD_ADD_BREAKPOINT=7,
	CMD_REMOVE_BREAKPOINT=8,

	CMD_ADD_WATCHPOINT=9,
	CMD_REMOVE_WATCHPOINT=0xA,

	CMD_READ_MEM=0xB,
	CMD_WRITE_MEM=0xC,

	CMD_GET_SLOTS=0xD,

	CMD_READ_STATE=0xE,
	CMD_WRITE_STATE=0xF,

	CMD_GET_TBBLUE_REG=0x10,

	CMD_GET_SPRITES_PALETTE=0x11,
	CMD_GET_SPRITES=0x12,
	CMD_GET_SPRITE_PATTERNS=0x13,
	CMD_GET_SPRITES_CLIP_WINDOW_AND_CONTROL=0x14,

	CMD_SET_BORDER=0x15,
};

/**
 * DZRP notifications.
 */
export enum DZRP_NTF {
	NTF_PAUSE=1
};


/**
 * Used for the DZRP CMD_CONTINUE alternate command for performance
 * improvement.
 * Is not implemented yet in DeZog but the DZRP already defines it.
 */
export enum AlternateCommand {
	CONTINUE=0,   // I.e. no alternate command
	STEP_OVER=1,
	STEP_OUT=2
}


/**
 * A class that communicates with the remote via the DZRP protocol.
 * It is base class for all DZRP remote classes that implement
 * special transports like serial connection or socket.
 */
export class DzrpRemote extends RemoteBase {

	// The function to hold the Promise's resolve function for a continue request.
	protected continueResolve?: ({breakNumber, breakAddress, breakReasonString}) => void;

	// This flag is used to pause a step-out.
	protected pauseStep=false;

	// Object to allow to give time to vscode during long running 'steps'.
	protected timeWait: TimeWait;

	// A temporary array with the set breakpoints and conditions.
	// Undefined=no breakpoint is set.
	// The tmpBreakpoints are created out of the other breakpoints, assertBreakpoints and logpoints
	// as soon as the z80CpuContinue is called.
	// It allows access of the breakpoint by it's address.
	// This may happen seldom, but it can happen that 2 breakpoints share
	// the same address. Therefore the array contains an Array of GenericBreakpoints.
	// normally the inner array contains only 1 element.
	// The tmpBreakpoints are created when a Continue, StepOver, Stepinto
	// or StepOut starts.
	protected tmpBreakpoints = new Array<Array<GenericBreakpoint>>(0x10000);

	/// Constructor.
	/// Override this.
	constructor() {
		super();
	}


	/// Override.
	/// Initializes the machine.
	/// When ready it emits this.emit('initialized') or this.emit('error', Error(...));
	/// The successful emit takes place in 'onConnect' which should be called
	/// by 'doInitialization' after a successful connect.
	public async doInitialization(): Promise<void> {
	}


	/**
	 * Call this from 'doInitialization' when a successful connection
	 * has been opened to the Remote.
	 * @emits this.emit('initialized') or this.emit('error', Error(...))
	 */
	protected async onConnect(): Promise<void> {
		try {
			// Get configuration
			/*const resp=*/ await this.sendDzrpCmdInit();
			// Load sna or nex file
			const loadPath=Settings.launch.load;
			if (loadPath)
				await this.loadBin(loadPath);
			// Ready
			this.emit('initialized')
		}
		catch (err) {
			this.emit('error', err);
		}
	}


	/**
	 * Override.
	 * Stops the emulator.
	 * This will disconnect the socket to zesarux and un-use all data.
	 * Called e.g. when vscode sends a disconnectRequest
	 * @param handler is called after the connection is disconnected.
	 */
	public async disconnect(): Promise<void> {
	}


	/**
	* If cache is empty retrieves the registers from
	* the Remote.
	*/
	public async getRegisters(): Promise<void> {
		if (Z80Registers.valid())
			return;

		// Get regs
		const regs=await this.sendDzrpCmdGetRegisters();
		// And set
		Z80Registers.setCache(regs);
	}


	/**
	 * Sets the value for a specific register.
	 * Reads the value from the emulator and returns it in the promise.
	 * Note: if in reverse debug mode the function should do nothing and the promise should return the previous value.
	 * @param register The register to set, e.g. "BC" or "A'". Note: the register name has to exist. I.e. it should be tested before.
	 * @param value The new register value.
	 * @return Promise with the "real" register value.
	 */
	public async setRegisterValue(register: string, value: number): Promise<number> {
		const index=Z80RegistersClass.getEnumFromName(register) as number;
		Utility.assert(index!=undefined);
		// Send command to set register
		await this.sendDzrpCmdSetRegister(index, value);
		// Send command to get registers
		Z80Registers.clearCache();
		await this.getRegisters();
		// Return
		const realValue=Z80Registers.getRegValueByName(register);
		return realValue;
	}


	/**
	 * Searches the 'breakpoints', the 'assertBreakpoints' and the
	 * 'logpoints' arrays for the given breakpoint ID.
	 * In fact searches tmpBreakpoints. Therefore make sure you called
	 * createTemporaryBreakpoints before.
	 * @param bpAddress the breakpoint address to search (!=0).
	 * @returns The found GenericBreakpoints (or RemoteBreakPoints) or
	 * [] if no breakpoint found.
	 */
	protected getBreakpointsByAddress(bpAddress: number): Array<GenericBreakpoint> {
		const foundBps=this.tmpBreakpoints[bpAddress]||[];
		// Nothing found
		return foundBps;
	}

	/**
	 * Creates a temporary array from the given array.
	 * The structure is more performant for use in a
	 * loop:
	 * The array contains 65536 entries, i.e. addresses. If no BP
	 * is set for an address the entry is undefined.
	 * If one is set the entry contains a pointer to the breakpoint.
	 * Or better it contains an array of breakpoints that all share the
	 * same address.
	 * Note: normally this array contains only one entry.
	 */
	protected createTemporaryBreakpoints() {
		const tmpBps=this.tmpBreakpoints;
		// Clear
		tmpBps.fill(undefined as any);
		// Get all breakpoints from the enabled logpoints
		const enabledLogPoints=this.getEnabledLogpoints();
		// Assert breakpoints
		const assertBps=(this.assertBreakpointsEnabled)? this.assertBreakpoints:[];
		const allBps=[...this.breakpoints, ...enabledLogPoints, ...assertBps];
		allBps.forEach(bp => {
			let bpInner=
				tmpBps[bp.address];
			if (!bpInner) {
				// Create new array
				bpInner=new Array<GenericBreakpoint>();
				tmpBps[bp.address]=bpInner;
			}
			bpInner.push(bp);
		});
	}


	/**
	 * Takes a breakpoint and checks if it's condition is true and if
	 * log needs to be done.
	 * @param bp The GenericBreakpoint.
	 * @returns [condition, log]
	 * condition:
	 * - undefined = Condition not met
	 * - otherwise: The condition text or '' if no condition was set.
	 * log:
	 * - undefined: No log breakpoint or condition not met
	 * - otherwise: The logpoint text (and condition met).
	 */
	protected checkConditionAndLog(bp: GenericBreakpoint|undefined): {condition: string|undefined, log: string|undefined} {
		if (bp) {
			if (bp.condition) {
				// Check if condition is true
				// TODO: If I would allow 'await evalExpression' I coould also allow e.g. memory checks
				const evalCond=Utility.evalExpression(bp.condition, true);
				if (evalCond!=0)
					return {condition: bp.condition, log: bp.log};
				return {condition: undefined, log: bp.log};
			}
			else {
				// No condition
				return {condition: '', log: bp.log};
			}
		}
		return {condition: '', log: undefined};
	}


	/**
	 * Constructs a human readable break-reason-string from the break number, data and
	 * an already existing reason string.
	 * @param breakNumber E.g. BREAK_REASON_NUMBER.WATCHPOINT_READ.
	 * @param breakAddress E.g. the breakpoint or the watchpoint address.
	 * @param condition An additional condition or '' if no condition.
	 * @param breakReasonString An already existing (part of the) reason string.
	 * The string transmitted from the remote.
	 * @returns A Promise to the reason string, e.g. "Breakpoint hit. A==4."
	 */

	protected async constructBreakReasonString(breakNumber: number, breakAddress: number, condition: string, breakReasonString: string): Promise<string> {
		Utility.assert(condition!=undefined);
		if (breakReasonString==undefined)
			breakReasonString='';

		// Generate reason text
		let reasonString;
		switch (breakNumber) {
			case BREAK_REASON_NUMBER.NO_REASON:
				reasonString="";
				break;
			case BREAK_REASON_NUMBER.MANUAL_BREAK:
				reasonString="Manual break.";
				break;
			case BREAK_REASON_NUMBER.BREAKPOINT_HIT:
				// Check if it was an ASSERT.
				const abps=this.assertBreakpoints.filter(abp => abp.address==breakAddress);
				for (const abp of abps) {
					if (condition==abp.condition) {
						const assertCond=Utility.getAssertFromCondition(condition);
						reasonString="Assertion failed: "+assertCond;
						return reasonString;
					}
				}
				// Or breakpoint
				if (reasonString==undefined) {
					reasonString="Breakpoint hit @"+Utility.getHexString(breakAddress, 4)+"h.";
					if (condition)
						reasonString+=" Condition: "+condition;
				}
				return reasonString;

			case BREAK_REASON_NUMBER.WATCHPOINT_READ:
			case BREAK_REASON_NUMBER.WATCHPOINT_WRITE:
				// Watchpoint
				const address=breakAddress;
				const labels=Labels.getLabelsForNumber(address);
				labels.push(address.toString());	// as decimal number
				const labelsString=labels.join(', ');
				reasonString="Watchpoint "+((breakNumber==BREAK_REASON_NUMBER.WATCHPOINT_READ)? "read":"write")+" access at address 0x"+Utility.getHexString(address, 4)+" ("+labelsString+"). "+breakReasonString;
				break;
			default:
				reasonString=breakReasonString;
		}

		return reasonString;
	}


	/**
	 * This method is called before a step (stepOver, stepInto, stepOut,
	 * continue, stepBack, etc.) is called.
	 */
	public startProcessing() {
		this.createTemporaryBreakpoints();
		// Reset flag
		this.pauseStep=false;
		// Start timer
		this.timeWait=new TimeWait(1000, 200, 100);	// Every second for 10ms
	}


	/**
	 * This method is called after a step (stepOver, stepInto, stepOut,
	 * continue, stepBack, etc.) is called.
	 */
	/*
	public stopProcessing() {
	}
	*/


	/**
	 * Evaluates the breakpoint condition and log (logpoint).
	 * Checks also pauseStep and returns '' if it is true.
	 * @param breakNumber The break reason as number, e.g. BREAK_REASON_NUMBER.BREAKPOINT_HIT
	 * @param breakAddress The address of the breakpoint (in future this could also be the address of a watchpoint).
	 * @returns undefined or the condition text.
	 * If the breakpoint condition is not true: undefined is returned.
	 * If the condition is true:
	 * - If a log is present the logtext is evaluated and a 'log' with the text will be emitted. 'undefined' is returned.
	 * - If no log is present the condition text is returned.
	 * All in all:
	 * If undefined is returned no break should be done.
	 * If a text is returned the bp condition was true and a break should be done.
	 *
	 * The correctedBreakNumber is normally the breakNumber
	 * that has been given. But in some cases a NO_REASON
	 * might be turned into a BREAKPOINT_HIT.
	 */
	protected async evalBpConditionAndLog(breakNumber: number, breakAddress: number): Promise<{condition: string|undefined, correctedBreakNumber: number}> {
		// Get registers
		//Z80Registers.clearCache();
		//await Remote.getRegisters();

		// Check breakReason, i.e. check if it was a watchpoint.
		let condition;
		let correctedBreakNumber=breakNumber;
		switch (breakNumber) {
			case BREAK_REASON_NUMBER.WATCHPOINT_READ:
			case BREAK_REASON_NUMBER.WATCHPOINT_WRITE:
				// TODO: evaluate condition
				// Condition not used at the moment
				condition='';
				break;

			case BREAK_REASON_NUMBER.NO_REASON:
			case BREAK_REASON_NUMBER.BREAKPOINT_HIT:
				// Get corresponding breakpoint
				const bps=this.getBreakpointsByAddress(breakAddress);

				// Loop over all matching breakpoints (normally only one)
				for (const bp of bps) {
					// Check for condition
					const {condition: cond, log}=this.checkConditionAndLog(bp);
					condition=cond;

					// Emit log?
					if (condition!=undefined&&log) {
						// Convert
						const evalLog=await Utility.evalLogString(log);
						// Print
						this.emit('log', evalLog);
						// Don't eval condition again
						condition=undefined;
					}

					if (condition!=undefined) {
						// At least one break condition found
						correctedBreakNumber=BREAK_REASON_NUMBER.BREAKPOINT_HIT;
						break;
					}
				}

				// Handle continue-breakpoints
				if (breakNumber==BREAK_REASON_NUMBER.NO_REASON) {
					// Only if other breakpoints not found or condition is false
					if (condition==undefined) {
						// Temporary breakpoint hit.
						condition='';
					}
				}
				break;

			default:
				// An other reason, e.g. manual break
				condition='';	// Do a break.
		}

		// Check for pause
		if (correctedBreakNumber==BREAK_REASON_NUMBER.NO_REASON||condition==undefined) {
			// Check for manual pause
			if (this.pauseStep) {
				condition='';	// Break
				correctedBreakNumber=BREAK_REASON_NUMBER.MANUAL_BREAK;
			}
		}

		return {condition, correctedBreakNumber};
	}


	/**
	 * 'continue' debugger program execution.
	 * @returns A Promise with a string containing the break reason.
	 */
	public async continue(): Promise<string> {
		return new Promise<string>(async resolve => {
			// Use a custom function here to evaluate breakpoint condition and log string.
			const funcContinueResolve = async ({breakNumber, breakAddress, breakReasonString}) => {
				try {
					// Give vscode a little time
					await this.timeWait.waitAtInterval();

					// Get registers
					Z80Registers.clearCache();
					await Remote.getRegisters();

					// Check for break condition
					const {condition, correctedBreakNumber}=await this.evalBpConditionAndLog(breakNumber, breakAddress);

					// Check for continue
					if (condition==undefined) {
						// Continue
						this.continueResolve=funcContinueResolve;
						this.sendDzrpCmdContinue();
					}
					else {
						// Construct break reason string to report
						breakReasonString=await this.constructBreakReasonString(correctedBreakNumber, breakAddress, condition, breakReasonString);
						// Clear registers
						Z80Registers.clearCache();
						this.clearCallStack();
						// return
						resolve(breakReasonString);
					}
				}
				catch (e) {
					// Clear registers
					Z80Registers.clearCache();
					this.clearCallStack();
					const reason: string=e;
					resolve(reason);
				}
			};

			// Send 'run' command
			this.continueResolve=funcContinueResolve;
			this.sendDzrpCmdContinue();
		});
	}


	/**
	 * 'pause' the debugger.
	 */
	public async pause(): Promise<void> {
		// Set this flag to pause a stepOut etc
		this.pauseStep=true;
		// Send 'run' command
		await this.sendDzrpCmdPause();
	}


	/**
	 * 'step over' an instruction in the debugger.
	 * @param stepOver true=step-over, false=step-into.
	 * @returns A Promise with:
	 * 'instruction' is the disassembly of the current line.
	 * 'breakReasonString' a possibly text with the break reason.
	 */
	public async stepOver(stepOver = true): Promise<{instruction: string, breakReasonString?: string}> {
		return new Promise<{instruction: string, breakReasonString?: string}>(async resolve => {
			// Prepare for break: This function is called by the PAUSE (break) notification:
			const funcContinueResolve=async ({breakNumber, breakAddress, breakReasonString}) => {
				// Give vscode a little time
				await this.timeWait.waitAtInterval();

				// Get registers
				Z80Registers.clearCache();
				await Remote.getRegisters();

				// Check for break condition
				let {condition, correctedBreakNumber}=await this.evalBpConditionAndLog(breakNumber, breakAddress);

				// Check for continue
				if (condition==undefined) {
					// Calculate the breakpoints to use for step-over/step-into
					let [, bp1, bp2]=await this.calcStepBp(stepOver);
					// Continue
					this.continueResolve=funcContinueResolve;
					this.sendDzrpCmdContinue(bp1, bp2);
				}
				else {
					// Construct break reason string to report
					breakReasonString=await this.constructBreakReasonString(correctedBreakNumber, breakAddress, condition, breakReasonString);
					// Clear registers
					this.clearCallStack();
					// return
					resolve({instruction, breakReasonString});
				}
			};

			// Calculate the breakpoints to use for step-over
			await this.getRegisters();
			let [opcode, bp1, bp2]=await this.calcStepBp(stepOver);
			// Disassemble
			const pc=this.getPC();
			const opCodeDescription=opcode.disassemble();
			const instruction=Utility.getHexString(pc, 4)+' '+opCodeDescription.mnemonic;
			// Send 'run' command
			this.continueResolve=funcContinueResolve;
			// Send command to 'continue'
			await this.sendDzrpCmdContinue(bp1, bp2);
		});
	}


	/**
	 * 'step into' an instruction in the debugger.
	 * @returns A Promise:
	 * 'instruction' is the disassembly of the current line.
	 * 'breakReasonString' a possibly text with the break reason. This is mainly to keep the
	 * record consistent with stepOver. But it is e.g. used to inform when the
	 * end of the cpu history is reached.
	 */
	public async stepInto(): Promise<{instruction: string, breakReasonString?: string}> {
		return this.stepOver(false);
	}


	/**
	 * 'step out' of current subroutine.
	 * The step-out uses normal step (into) functionality and checks
	 * after each step if the last instruction was some RET and
	 * the stackpointer is bigger than at the beginning.
	 * @returns A Promise with a string containing the break reason.
	 */
	public async stepOut(): Promise<string> {
		return new Promise<string>(async resolve => {
			// Get current SP
			const startSp=Z80Registers.getRegValue(Z80_REG.SP);
			let prevSp=startSp;
			let prevPc=0;

			// Use a custom function here to evaluate breakpoint condition and log string.
			const funcContinueResolve=async ({breakNumber, breakAddress, breakReasonString}) => {
				try {
					// Give vscode a little time
					await this.timeWait.waitAtInterval();

					// Get registers
					Z80Registers.clearCache();
					await Remote.getRegisters();

					// Check for break condition
					let {condition, correctedBreakNumber}=await this.evalBpConditionAndLog(breakNumber, breakAddress);
					// For StepOut ignore the stepping tmp breakpoints
					if (correctedBreakNumber==BREAK_REASON_NUMBER.NO_REASON)
						condition=undefined;

					// Check if instruction was a RET(I/N)
					if (condition==undefined) {
						const currSp=Z80Registers.getRegValue(Z80_REG.SP);
						if (currSp>startSp&&currSp>prevSp) {
							// Something has been popped. This is to exclude unexecuted RET cc.
							const bytes=await this.readMemoryDump(prevPc, 2);
							const opcodes=bytes[0]+(bytes[1]<<8);
							if (this.isRet(opcodes)) {
								// Stop here
								condition='';
								correctedBreakNumber=BREAK_REASON_NUMBER.NO_REASON;
							}
						}
					}

					// Check for continue
					if (condition==undefined) {
						// Calculate the breakpoints to use for step-over
						let [, bp1, bp2]=await this.calcStepBp(true);
						// Continue
						this.continueResolve=funcContinueResolve;
						prevPc=Z80Registers.getPC();
						this.sendDzrpCmdContinue(bp1, bp2);
					}
					else {
						// Construct break reason string to report
						breakReasonString=await this.constructBreakReasonString(correctedBreakNumber, breakAddress, condition, breakReasonString);
						// Clear registers
						Z80Registers.clearCache();
						this.clearCallStack();
						// return
						resolve(breakReasonString);
					}
				}
				catch (e) {
					// Clear registers
					Z80Registers.clearCache();
					this.clearCallStack();
					const reason: string=e;
					resolve(reason);
				}
			};

			// Calculate the breakpoints to use for step-over
			let [, bp1, bp2]=await this.calcStepBp(true);
			// Send 'run' command
			this.continueResolve=funcContinueResolve;
			prevPc=Z80Registers.getPC();
			this.sendDzrpCmdContinue(bp1, bp2);
		});
	}


	/**
	 * Tests if the opcode is a RET instruction.
	 * @param opcodes E.g. 0xe52a785c
	 * @returns false=if not RET (or RETI or RETN or RET cc).
	 */
	public isRet(opcodes: number): boolean {
		// Check for RET
		const opcode0=opcodes&0xFF;
		if (0xC9==opcode0)
			return true;

		// Check for RETI or RETN
		if (0xED==opcode0) {
			const opcode1=(opcodes>>>8)&0xFF;
			if (0x4D==opcode1||0x45==opcode1)
				return true;
		}

		// Now check for RET cc
		const mask=0b11000111;
		if ((opcode0&mask)==0b11000000) {
			// RET cc
			return true;
		}

		// No RET
		return false;
	}


	/**
	 * Sets one watchpoint in the remote.
	 * Watchpoints result in a break in the program run if one of the addresses is written or read to.
	 * Promises is execute when last watchpoint has been set.
	 * @param wp The watchpoint to set. Will set 'bpId' in the 'watchPoint'.
	 */
	public async setWatchpoint(wp: GenericWatchpoint): Promise<void> {
		await this.sendDzrpCmdAddWatchpoint(wp.address, wp.size, wp.access, wp.condition);
	}


	/**
	 * Removes one watchpoint from the remote.
	 * Promises is execute when last watchpoint has been set.
	 * @param wp The watchpoint to renove. Will set 'bpId' in the 'watchPoint' to undefined.
	 */
	public async removeWatchpoint(wp: GenericWatchpoint): Promise<void> {
		await this.sendDzrpCmdRemoveWatchpoint(wp.address, wp.size);
	}


	/**
	 * Enables/disables all assert breakpoints set from the sources.
	 * @param enable true=enable, false=disable.
	 */
	public async enableAssertBreakpoints(enable: boolean): Promise<void> {
		for (let abp of this.assertBreakpoints) {
			if (enable) {
				// Set breakpoint
				if (!abp.bpId) {
					const bpId=await this.sendDzrpCmdAddBreakpoint(abp.address);
					abp.bpId=bpId;
				}
			}
			else {
				// Remove breakpoint
				if (abp.bpId) {
					await this.sendDzrpCmdRemoveBreakpoint(abp.bpId);
					abp.bpId=undefined;
				}
			}
		}
		this.assertBreakpointsEnabled=enable;
	}


	/**
	 * Enables/disable all given points.
	 * Called at startup and once by enableLogpointGroup (to turn a group on or off).
	 * Promise is called after the last logpoint is set.
	 * @param logpoints A list of addresses to put a log breakpoint on.
	 * @param enable Enable or disable the logpoints.
	 * @returns A promise that is called after the last watchpoint is set.
	 */
	public async enableLogpoints(logpoints: Array<GenericBreakpoint>, enable: boolean): Promise<void> {
		// Logpoints are treated as normal breakpoints but without a reference to the source file.
		// This is not necessary as on a logpoint the execution simply continues after
		// logging.
		for (let lp of logpoints) {
			if (enable) {
				// Set breakpoint
				if (!lp.bpId) {
					const bpId=await this.sendDzrpCmdAddBreakpoint(lp.address);
					lp.bpId=bpId;
				}
			}
			else {
				// Remove breakpoint
				if (lp.bpId) {
					await await this.sendDzrpCmdRemoveBreakpoint(lp.bpId);
					lp.bpId=undefined;
				}
			}
		}
	}


	/*
	 * Sets breakpoint in the Remote.
	 * Sets the breakpoint ID (bpId) in bp.
	 * @param bp The breakpoint.
	 * @returns The used breakpoint ID. 0 if no breakpoint is available anymore.
	 */
	public async setBreakpoint(bp: RemoteBreakpoint): Promise<number> {

		// Check if "real" PC breakpoint
		if (bp.address<0) {
			this.emit('warning', 'DZRP does only support PC breakpoints.');
			// set to unverified
			bp.address=-1;
			return 0;
		}

		// Set breakpoint
		const bpId=await this.sendDzrpCmdAddBreakpoint(bp.address, bp.condition);

		// Add to list
		bp.bpId=bpId;
		this.breakpoints.push(bp);

		// return
		return bpId;
	}


	/**
	 * Clears one breakpoint.
	 */
	protected async removeBreakpoint(bp: RemoteBreakpoint): Promise<void> {
		await this.sendDzrpCmdRemoveBreakpoint(bp.bpId);

		// Remove from list
		let index=this.breakpoints.indexOf(bp);
		Utility.assert(index!==-1, 'Breakpoint should be removed but does not exist.');
		this.breakpoints.splice(index, 1);
	}


	/**
	 * Reads a memory.
	 * @param address The memory start address.
	 * @param size The memory size.
	 * @returns A promise with an Uint8Array.
	 */
	public async readMemoryDump(address: number, size: number): Promise<Uint8Array> {
		return await this.sendDzrpCmdReadMem(address, size);
	}


	/**
	 * Writes a memory dump.
	 * @param address The memory start address.
	 * @param dataArray The data to write.
	 */
	public async writeMemoryDump(address: number, dataArray: Uint8Array): Promise<void> {
		await this.sendDzrpCmdWriteMem(address, dataArray);
	}


	/**
	 * Reads the memory pages, i.e. the slot/banks relationship from zesarux
	 * and converts it to an array of MemoryBanks.
	 * @returns A Promise with an array with the available memory pages.
	 */
	public async getMemoryBanks(): Promise<MemoryBank[]> {
		// Prepare array
		const pages: Array<MemoryBank>=[];
		// Get the data
		const data=await this.sendDzrpCmdGetSlots();
		// Save in array
		let start=0x0000;
		data.map(slot => {
			const end=start+ZxMemory.MEMORY_BANK_SIZE-1;
			const name=(slot>=254)? "ROM":"BANK"+slot;
			pages.push({start, end, name});
			start+=ZxMemory.MEMORY_BANK_SIZE;
		});
		// Return
		return pages;
	}


	/**
	 * Loads .nex or .sna files.
	 */
	protected async loadBin(filePath: string): Promise<void> {
		// Check file extension
		const ext=path.extname(filePath);
		if (ext=='.sna')
			await this.loadBinSna(filePath);
		else if (ext=='.nex')
			await this.loadBinNex(filePath);
		else {
			// Error: neither sna nor nex file
			throw Error("File extension not supported in '"+filePath+"' with remoteType:'"+Settings.launch.remoteType+"'. Can only load .sna and .nex files.");
		}
		// Make sure that the registers are reloaded
		Z80Registers.clearCache();
		this.clearCallStack();
	}


	/**
	 * Loads object file (binary without any meta data).
	 * @param filePath The absolute path to the file.
	 * @param startAddress The address where the data should be loaded.
	 */
	protected async loadObj(filePath: string, startAddress: number): Promise<void> {
		// Read file
		const objBuffer=fs.readFileSync(filePath);

		// Write as memory dump
		this.sendDzrpCmdWriteMem(startAddress, objBuffer);

		// Make sure that the registers are reloaded
		Z80Registers.clearCache();
		this.clearCallStack();
	}


	/**
	 * Loads a .sna file.
	 * See https://faqwiki.zxnet.co.uk/wiki/SNA_format
	 */
	protected async loadBinSna(filePath: string): Promise<void> {
		// Load and parse file
		const snaFile=new SnaFile();
		snaFile.readFile(filePath);

		// Set the border
		await this.sendDzrpCmdSetBorder(snaFile.borderColor);

		// Transfer 16k memory banks
		for (const memBank of snaFile.memBanks) {
			// As 2x 8k memory banks
			const bank8=2*memBank.bank;
			await this.sendDzrpCmdWriteBank(bank8, memBank.data.slice(0, MemBank16k.BANK16K_SIZE/2));
			await this.sendDzrpCmdWriteBank(bank8+1, memBank.data.slice(MemBank16k.BANK16K_SIZE/2));
		}

		// Set the registers
		await this.sendDzrpCmdSetRegister(Z80_REG.PC, snaFile.pc);
		await this.sendDzrpCmdSetRegister(Z80_REG.SP, snaFile.sp);
		await this.sendDzrpCmdSetRegister(Z80_REG.AF, snaFile.af);
		await this.sendDzrpCmdSetRegister(Z80_REG.BC, snaFile.bc);
		await this.sendDzrpCmdSetRegister(Z80_REG.DE, snaFile.de);
		await this.sendDzrpCmdSetRegister(Z80_REG.HL, snaFile.hl);
		await this.sendDzrpCmdSetRegister(Z80_REG.IX, snaFile.ix);
		await this.sendDzrpCmdSetRegister(Z80_REG.IY, snaFile.iy);
		await this.sendDzrpCmdSetRegister(Z80_REG.AF2, snaFile.af2);
		await this.sendDzrpCmdSetRegister(Z80_REG.BC2, snaFile.bc2);
		await this.sendDzrpCmdSetRegister(Z80_REG.DE2, snaFile.de2);
		await this.sendDzrpCmdSetRegister(Z80_REG.HL2, snaFile.hl2);
		await this.sendDzrpCmdSetRegister(Z80_REG.R, snaFile.r);
		await this.sendDzrpCmdSetRegister(Z80_REG.I, snaFile.i);
		await this.sendDzrpCmdSetRegister(Z80_REG.IM, snaFile.im);
	}


	/**
	 * Loads a .nex file.
	 * See https://wiki.specnext.dev/NEX_file_format
	 */
	protected async loadBinNex(filePath: string): Promise<void> {
		// Load and parse file
		const nexFile=new NexFile();
		nexFile.readFile(filePath);

		// Set the border
		await this.sendDzrpCmdSetBorder(nexFile.borderColor);

		// Transfer 16k memory banks
		for (const memBank of nexFile.memBanks) {
			// As 2x 8k memory banks
			const bank8=2*memBank.bank;
			await this.sendDzrpCmdWriteBank(bank8, memBank.data.slice(0, MemBank16k.BANK16K_SIZE/2));
			await this.sendDzrpCmdWriteBank(bank8+1, memBank.data.slice(MemBank16k.BANK16K_SIZE/2));
		}

		// Set the SP and PC registers
		await this.sendDzrpCmdSetRegister(Z80_REG.SP, nexFile.sp);
		await this.sendDzrpCmdSetRegister(Z80_REG.PC, nexFile.pc);
	}


	/**
	 * Called from "-state save" command.
	 * Stores all RAM, registers etc.
	 * Override.
	 * @param filePath The file path to store to.
	 */
	public async stateSave(filePath: string): Promise<void> {
		// Get state data
		const stateData=await this.sendDzrpCmdReadState();
		// Zip data
		const zippedData=await gzip(stateData);
		// Save data to .tmp/states directory
		fs.writeFileSync(filePath, zippedData);
	}


	/**
	 * Called from "-state restore" command.
	 * Restores all RAM + the registers from a former "-state save".
	 * Override.
	 * @param filePath The file path to retore from.
	 */
	public async stateRestore(filePath: string): Promise<void> {
		// Read state dta
		const zippedData=fs.readFileSync(filePath);
		// Unzip data
		const stateData=await ungzip(zippedData);
		// Restore data
		await this.sendDzrpCmdWriteState(stateData);
		// Clear register cache
		Z80Registers.clearCache();
		this.clearCallStack();
	}



	// ZX Next related ---------------------------------


	/**
	 * Retrieves the TBBlue register value from the emulator.
	 * @param registerNr The number of the register.
	 * @returns A promise with the value of the register.
	 */
	public async getTbblueRegister(registerNr: number): Promise<number> {
		const value=await this.sendDzrpCmdGetTbblueReg(registerNr);
		return value;
	}


	/**
	 * Retrieves the sprites palette from the emulator.
	 * @param paletteNr 0 or 1.
	 * @returns A Promise that returns a 256 element Array<number> with the palette values.
	 */
	public async getTbblueSpritesPalette(paletteNr: number): Promise<Array<number>> {
		const palette=await this.sendDzrpCmdGetSpritesPalette(paletteNr);
		return palette;
	}


	/**
	 * Retrieves the sprites clipping window from the emulator.
	 * @returns A Promise that returns the clipping dimensions and teh control byte(xl, xr, yt, yb, control).
	 */
	public async getTbblueSpritesClippingWindow(): Promise<{xl: number, xr: number, yt: number, yb: number, control: number}> {
		const clip=await this.sendDzrpCmdGetSpritesClipWindow();
		return clip;
	}


	/**
	 * Retrieves the sprites from the emulator.
	 * @param slot The start slot.
	 * @param count The number of slots to retrieve.
	 * @returns A Promise with an array of sprite attribute data.
	 */
	public async getTbblueSprites(slot: number, count: number): Promise<Array<Uint8Array>> {
		const sprites=await this.sendDzrpCmdGetSprites(slot, count);
		return sprites;
	}


	/**
	 * Retrieves the sprite patterns from the emulator.
	 * @param index The start index.
	 * @param count The number of patterns to retrieve.
	 * @preturns A Promise with an array of sprite pattern data.
	 */
	public async getTbblueSpritePatterns(index: number, count: number): Promise<Array<Array<number>>> {
		const patterns=await this.sendDzrpCmdGetSpritePatterns(index, count);
		return patterns;
	}





	//------- Send Commands -------

	/**
	 * Override.
	 * The first command send. Includes the version number.
	 * @returns The configuration, e.g. '{xNextRegs: true}'
	 */
	protected async sendDzrpCmdInit(): Promise<Array<number>> {
		Utility.assert(false);
		return [0,0,0];
	}


	/**
	 * Override.
	 * Sends the command to get all registers.
	 * @returns An Uint16Array with the register data. Same order as in
	 * 'Z80Registers.getRegisterData'.
	 */
	protected async sendDzrpCmdGetRegisters(): Promise<Uint16Array> {
		Utility.assert(false);
		return new Uint16Array(0);
	}


	/**
	 * Override.
	 * Sends the command to set a register value.
	 * @param regIndex E.g. Z80_REG.BC or Z80_REG.A2
	 * @param value A 1 byte or 2 byte value.
	 */
	protected async sendDzrpCmdSetRegister(regIndex: Z80_REG, value: number): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to continue ('run') the program.
	 * @param bp1Address The address of breakpoint 1 or undefined if not used.
	 * @param bp2Address The address of breakpoint 2 or undefined if not used.
	 */
	protected async sendDzrpCmdContinue(bp1Address?: number, bp2Address?: number): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to pause a running program.
	 */
	protected async sendDzrpCmdPause(): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to add a breakpoint.
	 * @param bpAddress The breakpoint address. 0x0000-0xFFFF.
	 * @param condition The breakpoint condition as string. If there is n condition
	 * 'condition' may be undefined or an empty string ''.
	 * @returns A Promise with the breakpoint ID (1-65535) or 0 in case
	 * no breakpoint is available anymore.
	 */
	protected async sendDzrpCmdAddBreakpoint(bpAddress: number, condition?: string): Promise<number> {
		Utility.assert(false);
		return 0;
	}


	/**
	 * Override.
	 * Sends the command to remove a breakpoint.
	 * @param bpId The breakpoint ID to remove.
	 */
	protected async sendDzrpCmdRemoveBreakpoint(bpId: number): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to add a watchpoint.
	 * @param address The watchpoint address. 0x0000-0xFFFF.
	 * @param size The size of the watchpoint. address+size-1 is the last address for the watchpoint.
	 * I.e. you can watch whole memory areas.
	 * @param access Read "r" or write "w" access, or both "rw".
	 * @param condition The watchpoint condition as string. If there is n0 condition
	 * 'condition' may be undefined or an empty string ''.
	 */
	protected async sendDzrpCmdAddWatchpoint(address: number, size: number, access: string, condition: string): Promise<void> {
		throw Error("Watchpoints not supported!");
	}


	/**
	 * Override.
	 * Sends the command to remove a watchpoint for an address range.
	 * @param address The watchpoint address. 0x0000-0xFFFF.
	 * @param size The size of the watchpoint. address+size-1 is the last address for the watchpoint.
	 */
	protected async sendDzrpCmdRemoveWatchpoint(address: number, size: number): Promise<void> {
		throw Error("Watchpoints not supported!");
	}


	/**
	 * Override.
	 * Sends the command to retrieve a memory dump.
	 * @param address The memory start address.
	 * @param size The memory size.
	 * @returns A promise with an Uint8Array.
	 */
	protected async sendDzrpCmdReadMem(address: number, size: number): Promise<Uint8Array> {
		Utility.assert(false);
		return new Uint8Array(0);
	}


	/**
	 * Override.
	 * Sends the command to write a memory dump.
	 * @param address The memory start address.
	 * @param dataArray The data to write.
 	*/
	public async sendDzrpCmdWriteMem(address: number, dataArray: Buffer|Uint8Array): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to write a memory bank.
	 * @param bank 8k memory bank number.
	 * @param dataArray The data to write.
 	*/
	public async sendDzrpCmdWriteBank(bank: number, dataArray: Buffer|Uint8Array): Promise<void> {
		Utility.assert(false);
	}


	/**
	 * Override.
	 * Sends the command to read the slot/bank associations (8k banks).
	 * @returns A Promise with an number array of 8 slots.
	 *  Each entry contains the correspondent bank number.
 	*/
	public async sendDzrpCmdGetSlots(): Promise<number[]> {
		Utility.assert(false);
		return [];
	}


	/**
	 * Override.
	 * Sends the command to read the current state of the machine.
	 * I.e. memory, registers etc.
	 * @returns A Promise with state data. Format is unknown (remote specific).
	 * Data will just be saved.
 	*/
	public async sendDzrpCmdReadState(): Promise<Uint8Array> {
		throw Error("Read state not supported!");
		//return new Uint8Array();
	}


	/**
	 * Override.
	 * Sends the command to wite a previously saved state to the remote.
	 * I.e. memory, registers etc.
	 * @param The state data. Format is unknown (remote specific).
 	*/
	public async sendDzrpCmdWriteState(stateData: Uint8Array): Promise<void> {
		throw Error("Write state not supported!");
	}



	/**
	 * Returns the value of one TBBlue register.
	 * @param register  The Tbblue register.
	 * @returns A promise with the value.
 	*/
	public async sendDzrpCmdGetTbblueReg(register: number): Promise<number> {
		Utility.assert(false);
		return 0;
	}


	/**
	 * Sends the command to get a sprites palette.
	 * @param index o/1. The first or the second palette.
	 * @returns An array with 256 entries with the 9 bit color.
 	*/
	public async sendDzrpCmdGetSpritesPalette(index: number): Promise<Array<number>> {
		throw Error("Get sprite palette not supported!");
		//return [];
	}


	/**
	 * Sends the command to get a number of sprite attributes.
	 * @param index The index of the sprite.
	 * @param count The number of sprites to return.
	 * @returns An array with 5 byte attributes for each sprite.
 	*/
	public async sendDzrpCmdGetSprites(index: number, count: number): Promise<Array<Uint8Array>> {
		throw Error("Get sprites not supported!");
		//return [];
	}


	/**
	 * Sends the command to retrieve sprite patterns.
	 * Retrieves only 256 byte patterns. If a 128 byte patterns is required
	 * the full 256 bytes are returned.
	 * @param index The index of the pattern [0-63]
	 * @param count The number of patterns [0-64]
	 * @returns A promise with an Array with the sprite pattern for each index.
	 */
	protected async sendDzrpCmdGetSpritePatterns(index: number, count: number): Promise<Array<Array<number>>> {
		throw Error("Get sprite patterns not supported!");
		//return [[]];
	}


	/**
	 * Sends the command to get the sprites clipping window.
	 * @returns A Promise that returns the clipping dimensions and the control byte (xl, xr, yt, yb, control).
 	*/
	public async sendDzrpCmdGetSpritesClipWindow(): Promise<{xl: number, xr: number, yt: number, yb: number, control: number}> {
		throw Error("Get sprites clip window not supported!");
		//return {xl: 0, xr: 0, yt: 0, yb: 0, control: 0};
	}


	/**
	 * Sends the command to set the border.
 	*/
	public async sendDzrpCmdSetBorder(borderColor: number): Promise<void> {
		Utility.assert(false);
	}

}

