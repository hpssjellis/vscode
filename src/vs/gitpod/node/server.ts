/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Typefox. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedPlugins } from '@gitpod/gitpod-protocol';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { TasksStatusRequest, TasksStatusResponse, TaskState, TaskStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
import { ListTerminalsRequest, ListTerminalsResponse } from '@gitpod/supervisor-api-grpc/lib/terminal_pb';
import * as grpc from '@grpc/grpc-js';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import * as util from 'util';
import { getPathFromAmdModule } from 'vs/base/common/amd';
import { RunOnceScheduler } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { IRemoteConsoleLog } from 'vs/base/common/console';
import { onUnexpectedError, setUnexpectedErrorHandler } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { TernarySearchTree } from 'vs/base/common/map';
import { Schemas } from 'vs/base/common/network';
import * as platform from 'vs/base/common/platform';
import Severity from 'vs/base/common/severity';
import { ReadableStreamEventPayload } from 'vs/base/common/stream';
import { URI } from 'vs/base/common/uri';
import { IRawURITransformer, transformIncomingURIs, transformOutgoingURIs, URITransformer } from 'vs/base/common/uriIpc';
import { generateUuid } from 'vs/base/common/uuid';
import { mkdirp, readdir, rimraf, unlink } from 'vs/base/node/pfs';
import { getSystemShellSync } from 'vs/base/node/shell';
import { ClientConnectionEvent, IPCServer, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { PersistentProtocol, ProtocolConstants } from 'vs/base/parts/ipc/common/ipc.net';
import { NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { OpenSupervisorTerminalProcessOptions, SupervisorTerminalProcess } from 'vs/gitpod/node/supervisorTerminalProcess';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { IDownloadService } from 'vs/platform/download/common/download';
import { DownloadService } from 'vs/platform/download/common/downloadService';
import { IEnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { OPTIONS, parseArgs } from 'vs/platform/environment/node/argv';
import { NativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ConsoleLogMainService, getLogLevel, ILogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { LoggerChannel } from 'vs/platform/log/common/logIpc';
import product from 'vs/platform/product/common/product';
import { IProductService } from 'vs/platform/product/common/productService';
import { ConnectionType, ErrorMessage, HandshakeMessage, IRemoteExtensionHostStartParams, OKMessage, SignRequest } from 'vs/platform/remote/common/remoteAgentConnection';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { asText, IRequestService } from 'vs/platform/request/common/request';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { RequestService } from 'vs/platform/request/node/requestService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IFileChangeDto } from 'vs/workbench/api/common/extHost.protocol';
import { IEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { MergedEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableCollection';
import { deserializeEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableShared';
import { ICreateTerminalProcessArguments, ICreateTerminalProcessResult, IGetTerminalCwdArguments, IGetTerminalInitialCwdArguments, IGetTerminalLayoutInfoArgs, IOnTerminalProcessEventArguments, IRemoteTerminalDescriptionDto, IResizeTerminalProcessArguments, ISendCharCountToTerminalProcessArguments, ISendInputToTerminalProcessArguments, ISetTerminalLayoutInfoArgs, IShutdownTerminalProcessArguments, IStartTerminalProcessArguments, IWorkspaceFolderData } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { IRawTerminalTabLayoutInfo, IRemoteTerminalAttachTarget, IShellLaunchConfig, ITerminalLaunchError, ITerminalsLayoutInfo, ITerminalTabLayoutInfoById } from 'vs/workbench/contrib/terminal/common/terminal';
import { TerminalDataBufferer } from 'vs/workbench/contrib/terminal/common/terminalDataBuffering';
import * as terminalEnvironment from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { getMainProcessParentEnv } from 'vs/workbench/contrib/terminal/node/terminalEnvironment';
import { AbstractVariableResolverService } from 'vs/workbench/services/configurationResolver/common/variableResolver';
import { IExtHostReadyMessage, IExtHostSocketMessage } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { Logger } from 'vs/workbench/services/extensions/common/extensionPoints';
import { ExtensionScanner, ExtensionScannerInput, IExtensionReference } from 'vs/workbench/services/extensions/node/extensionPoints';
import { IGetEnvironmentDataArguments, IRemoteAgentEnvironmentDTO, IScanExtensionsArguments, IScanSingleExtensionArguments } from 'vs/workbench/services/remote/common/remoteAgentEnvironmentChannel';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';

const uriTransformerPath = path.join(__dirname, '../../../gitpodUriTransformer');
const rawURITransformerFactory: (remoteAuthority: string) => IRawURITransformer = <any>require.__$__nodeRequire(uriTransformerPath);

const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
const WEB_MAIN = path.join(APP_ROOT, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html');
const WEB_MAIN_DEV = path.join(APP_ROOT, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench-dev.html');

setUnexpectedErrorHandler(console.error);
// Print a console message when rejection isn't handled within N seconds. For details:
// see https://nodejs.org/api/process.html#process_event_unhandledrejection
// and https://nodejs.org/api/process.html#process_event_rejectionhandled
const unhandledPromises: Promise<any>[] = [];
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
	unhandledPromises.push(promise);
	setTimeout(() => {
		const idx = unhandledPromises.indexOf(promise);
		if (idx >= 0) {
			promise.catch(e => {
				unhandledPromises.splice(idx, 1);
				console.warn(`rejected promise not handled within 1 second: ${e}`);
				if (e && e.stack) {
					console.warn(`stack trace: ${e.stack}`);
				}
				onUnexpectedError(reason);
			});
		}
	}, 1000);
});

process.on('rejectionHandled', (promise: Promise<any>) => {
	const idx = unhandledPromises.indexOf(promise);
	if (idx >= 0) {
		unhandledPromises.splice(idx, 1);
	}
});

// Print a console message when an exception isn't handled.
process.on('uncaughtException', function (err: Error) {
	onUnexpectedError(err);
});

interface ManagementProtocol {
	protocol: PersistentProtocol
	graceTimeReconnection: RunOnceScheduler
	shortGraceTimeReconnection: RunOnceScheduler
}

interface Client {
	management?: ManagementProtocol
	extensionHost?: cp.ChildProcess
}

function safeDisposeProtocolAndSocket(protocol: PersistentProtocol): void {
	try {
		protocol.acceptDisconnect();
		const socket = protocol.getSocket();
		protocol.dispose();
		socket.dispose();
	} catch (err) {
		onUnexpectedError(err);
	}
}

// TODO is it enough?
const textMimeType = new Map([
	['.html', 'text/html'],
	['.js', 'text/javascript'],
	['.json', 'application/json'],
	['.css', 'text/css'],
	['.svg', 'image/svg+xml']
]);

// TODO is it enough?
const mapExtToMediaMimes = new Map([
	['.bmp', 'image/bmp'],
	['.gif', 'image/gif'],
	['.ico', 'image/x-icon'],
	['.jpe', 'image/jpg'],
	['.jpeg', 'image/jpg'],
	['.jpg', 'image/jpg'],
	['.png', 'image/png'],
	['.tga', 'image/x-tga'],
	['.tif', 'image/tiff'],
	['.tiff', 'image/tiff'],
	['.woff', 'application/font-woff']
]);

function getMediaMime(forPath: string): string | undefined {
	const ext = path.extname(forPath);
	return mapExtToMediaMimes.get(ext.toLowerCase());
}

async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string, responseHeaders: http.OutgoingHttpHeaders = {}) {
	try {

		// Sanity checks
		filePath = path.normalize(filePath); // ensure no "." and ".."

		const stat = await util.promisify(fs.stat)(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType.get(path.extname(filePath)) || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		console.error(error.toString());
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): void {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

async function installExtensionsFromServer(
	extensionManagementService: IExtensionManagementService,
	requestService: IRequestService,
	fileService: IFileService
): Promise<void> {
	const pending: Promise<void>[] = [];
	if (process.env.GITPOD_RESOLVED_EXTENSIONS) {
		let resolvedPlugins: ResolvedPlugins = {};
		try {
			resolvedPlugins = JSON.parse(process.env.GITPOD_RESOLVED_EXTENSIONS);
		} catch (e) {
			console.error('code server: failed to parse process.env.GITPOD_RESOLVED_EXTENSIONS:', e);
		}
		for (const pluginId in resolvedPlugins) {
			const resolvedPlugin = resolvedPlugins[pluginId];
			if (resolvedPlugin?.kind !== 'workspace') {
				// ignore built-in extensions configured for Theia, we default to VS Code built-in extensions
				// ignore user extensions installed in Theia, since we switched to the sync storage for them
				continue;
			}
			pending.push(installExtensionFromConfig(resolvedPlugin.url, extensionManagementService, requestService, fileService));
		}
	}
	if (process.env.GITPOD_EXTERNAL_EXTENSIONS) {
		let external: string[] = [];
		try {
			external = JSON.parse(process.env.GITPOD_EXTERNAL_EXTENSIONS);
		} catch (e) {
			console.error('code server: failed to parse process.env.GITPOD_EXTERNAL_EXTENSIONS:', e);
		}
		for (const url of external) {
			pending.push(installExtensionFromConfig(url, extensionManagementService, requestService, fileService));
		}
	}
	await Promise.all(pending);
}
async function installExtensionFromConfig(
	url: string,
	extensionManagementService: IExtensionManagementService,
	requestService: IRequestService,
	fileService: IFileService
): Promise<void> {
	try {
		const context = await requestService.request({ type: 'GET', url }, CancellationToken.None);
		if (context.res.statusCode !== 200) {
			const message = await asText(context);
			throw new Error(`expected 200, got back ${context.res.statusCode} instead.\n\n${message}`);
		}
		const downloadedLocation = path.join(os.tmpdir(), generateUuid());
		const target = URI.file(downloadedLocation);
		await fileService.writeFile(target, context.stream);
		await extensionManagementService.install(target, {
			isMachineScoped: true,
			isBuiltin: false
		});
	} catch (e) {
		console.error(`code server: failed to install configured extension from '${url}':`, e);
	}
}

async function main(): Promise<void> {
	const devMode = !!process.env['VSCODE_DEV'];
	let cliServerSocketsPath = path.join(os.tmpdir(), 'gitpod-cli-server-sockets');
	if (devMode) {
		cliServerSocketsPath += '-dev';
	}
	cliServerSocketsPath = path.join(cliServerSocketsPath, generateUuid());
	console.log('CLI server sockets path: ' + cliServerSocketsPath);

	const connectionToken = generateUuid();

	const parsedArgs = parseArgs(process.argv.splice(0, 2), OPTIONS);
	parsedArgs['user-data-dir'] = URI.file(path.join(os.homedir(), product.dataFolderName)).fsPath;
	const environmentService = new NativeEnvironmentService(parsedArgs);

	await rimraf(cliServerSocketsPath).catch(() => { });
	// see src/vs/code/electron-main/main.ts#182
	await Promise.all<void | undefined>([
		environmentService.extensionsPath,
		environmentService.logsPath,
		environmentService.globalStorageHome.fsPath,
		environmentService.workspaceStorageHome.fsPath,
		cliServerSocketsPath]
		.map((path): undefined | Promise<void> => path ? mkdirp(path) : undefined));

	const onDidClientConnectEmitter = new Emitter<ClientConnectionEvent>();
	const channelServer = new IPCServer<RemoteAgentConnectionContext>(onDidClientConnectEmitter.event);
	channelServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

	const logService = new MultiplexLogService([new ConsoleLogMainService(getLogLevel(environmentService))]);
	channelServer.registerChannel('logger', new LoggerChannel(logService));

	const systemExtensionRoot = path.normalize(path.join(getPathFromAmdModule(require, ''), '..', 'extensions'));
	const extraDevSystemExtensionsRoot = path.normalize(path.join(getPathFromAmdModule(require, ''), '..', '.build', 'builtInExtensions'));
	const logger = new Logger((severity, source, message) => {
		const msg = devMode && source ? `[${source}]: ${message}` : message;
		if (severity === Severity.Error) {
			console.error(msg);
		} else if (severity === Severity.Warning) {
			console.warn(msg);
		} else {
			console.log(msg);
		}
	});
	// see used APIs in vs/workbench/services/remote/common/remoteAgentEnvironmentChannel.ts
	class RemoteExtensionsEnvironment implements IServerChannel<RemoteAgentConnectionContext> {
		protected extensionHostLogFileSeq = 1;
		async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
			if (command === 'getEnvironmentData') {
				const args: IGetEnvironmentDataArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				return transformOutgoingURIs({
					pid: process.pid,
					connectionToken,
					appRoot: URI.file(environmentService.appRoot),
					settingsPath: environmentService.machineSettingsResource,
					logsPath: URI.file(environmentService.logsPath),
					extensionsPath: URI.file(environmentService.extensionsPath),
					extensionHostLogsPath: URI.file(path.join(environmentService.logsPath, `extension_host_${this.extensionHostLogFileSeq++}`)),
					globalStorageHome: environmentService.globalStorageHome,
					workspaceStorageHome: environmentService.workspaceStorageHome,
					userHome: environmentService.userHome,
					os: platform.OS,
					marks: []
				} as IRemoteAgentEnvironmentDTO, uriTranformer);
			}
			if (command === 'scanSingleExtension') {
				let args: IScanSingleExtensionArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				args = transformIncomingURIs(args, uriTranformer);
				// see scanSingleExtension in src/vs/workbench/services/extensions/electron-browser/cachedExtensionScanner.ts
				// TODO: read built nls file
				const translations = {};
				const input = new ExtensionScannerInput(product.version, product.commit, args.language, devMode, URI.revive(args.extensionLocation).fsPath, args.isBuiltin, false, translations);
				const extension = await ExtensionScanner.scanSingleExtension(input, console);
				if (!extension) {
					return undefined;
				}
				return transformOutgoingURIs(extension, uriTranformer);
			}
			if (command === 'scanExtensions') {
				let args: IScanExtensionsArguments = arg;
				const uriTranformer = new URITransformer(rawURITransformerFactory(args.remoteAuthority));
				args = transformIncomingURIs(args, uriTranformer);
				// see _scanInstalledExtensions in src/vs/workbench/services/extensions/electron-browser/cachedExtensionScanner.ts
				// TODO: read built nls file
				const translations = {};
				let pendingSystem = ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.commit, args.language, devMode, systemExtensionRoot, true, false, translations), logger);
				const builtInExtensions = product.builtInExtensions;
				if (devMode && builtInExtensions && builtInExtensions.length) {
					pendingSystem = ExtensionScanner.mergeBuiltinExtensions(pendingSystem, ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.commit, args.language, devMode, extraDevSystemExtensionsRoot, true, false, translations), logger, {
						resolveExtensions: () => {
							const result: IExtensionReference[] = [];
							for (const extension of builtInExtensions) {
								result.push({ name: extension.name, path: path.join(extraDevSystemExtensionsRoot, extension.name) });
							}
							return Promise.resolve(result);
						}
					}));
				}
				const pendingUser = extensionsInstalled.then(() => ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.commit, args.language, devMode, environmentService.extensionsPath, false, false, translations), logger));
				let pendingDev: Promise<IExtensionDescription[]>[] = [];
				if (args.extensionDevelopmentPath) {
					pendingDev = args.extensionDevelopmentPath.map(devPath => ExtensionScanner.scanExtensions(new ExtensionScannerInput(product.version, product.commit, args.language, devMode, URI.revive(devPath).fsPath, false, true, translations), logger));
				}
				const result: IExtensionDescription[] = [];
				const skipExtensions = new Set<string>(args.skipExtensions.map(ExtensionIdentifier.toKey));
				for (const extensions of await Promise.all([...pendingDev, pendingUser, pendingSystem])) {
					for (let i = extensions.length - 1; i >= 0; i--) {
						const extension = extensions[i];
						const key = ExtensionIdentifier.toKey(extension.identifier);
						if (skipExtensions.has(key)) {
							continue;
						}
						skipExtensions.add(key);
						result.unshift(transformOutgoingURIs(extension, uriTranformer));
					}
				}
				return result;
			}
			console.error('Unknown command: RemoteExtensionsEnvironment.' + command);
			throw new Error('Unknown command: RemoteExtensionsEnvironment.' + command);
		}
		listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
			console.error('Unknown event: RemoteExtensionsEnvironment.' + event);
			throw new Error('Unknown event: RemoteExtensionsEnvironment.' + event);
		}
	}
	channelServer.registerChannel('remoteextensionsenvironment', new RemoteExtensionsEnvironment());

	/**
	 * See ExtHostVariableResolverService in src/vs/workbench/api/common/extHostDebugService.ts for a reference implementation.
	 */
	class RemoteTerminalVariableResolverService extends AbstractVariableResolverService {

		private readonly structure = TernarySearchTree.forUris<IWorkspaceFolder>(() => false);

		constructor(folders: IWorkspaceFolder[], resolvedVariables: { [name: string]: string }, activeFileResource: URI | undefined, env: platform.IProcessEnvironment) {
			super({
				getFolderUri: (folderName: string): URI | undefined => {
					const found = folders.filter(f => f.name === folderName);
					if (found && found.length > 0) {
						return found[0].uri;
					}
					return undefined;
				},
				getWorkspaceFolderCount: (): number => {
					return folders.length;
				},
				getConfigurationValue: (folderUri: URI | undefined, section: string): string | undefined => {
					return resolvedVariables['config:' + section];
				},
				getExecPath: (): string | undefined => {
					return env['VSCODE_EXEC_PATH'];
				},
				getFilePath: (): string | undefined => {
					if (activeFileResource) {
						return path.normalize(activeFileResource.fsPath);
					}
					return undefined;
				},
				getWorkspaceFolderPathForFile: (): string | undefined => {
					if (activeFileResource) {
						const ws = this.structure.findSubstr(activeFileResource);
						if (ws) {
							return path.normalize(ws.uri.fsPath);
						}
					}
					return undefined;
				},
				getSelectedText: (): string | undefined => {
					return resolvedVariables.selectedText;
				},
				getLineNumber: (): string | undefined => {
					return resolvedVariables.lineNumber;
				}
			}, undefined, env);

			// setup the workspace folder data structure
			folders.forEach(folder => {
				this.structure.set(folder.uri, folder);
			});
		}

	}
	const toWorkspaceFolder = (data: IWorkspaceFolderData) => ({
		uri: URI.revive(data.uri),
		name: data.name,
		index: data.index,
		toResource: () => {
			throw new Error('Not implemented');
		}
	});

	const supervisorAddr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	const terminalServiceClient = new TerminalServiceClient(supervisorAddr, grpc.credentials.createInsecure());
	const statusServiceClient = new StatusServiceClient(supervisorAddr, grpc.credentials.createInsecure());

	const synchingTasks = (async () => {
		const tasks = new Map<string, TaskStatus>();
		console.log('code server: synching tasks...');
		let syhched = false;
		while (!syhched) {
			try {
				const req = new TasksStatusRequest();
				req.setObserve(true);
				const stream = statusServiceClient.tasksStatus(req);
				await new Promise((resolve, reject) => {
					stream.on('end', resolve);
					stream.on('error', reject);
					stream.on('data', (response: TasksStatusResponse) => {
						if (response.getTasksList().every(status => {
							tasks.set(status.getTerminal(), status);
							return status.getState() !== TaskState.OPENING;
						})) {
							syhched = true;
							stream.cancel();
						}
					});
				});
			} catch (err) {
				if (!('code' in err && err.code === grpc.status.CANCELLED)) {
					console.error('code server: listening task updates failed:', err);
				}
			}
			if (!syhched) {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}
		console.log('code server: tasks syhched');
		return tasks;
	})();

	type TerminalOpenMode = 'split-top' | 'split-left' | 'split-right' | 'split-bottom' | 'tab-before' | 'tab-after';
	const defaultOpenMode: TerminalOpenMode = 'tab-after';
	const terminalOpenModes: Set<TerminalOpenMode> = new Set(['split-top', 'split-left', 'split-right', 'split-bottom', 'tab-before', 'tab-after']);
	function asTerminalOpenMode(mode: any): TerminalOpenMode {
		if (terminalOpenModes.has(mode)) {
			return mode;
		}
		return defaultOpenMode;
	}

	class RemoteTerminalChannelServer implements IServerChannel<RemoteAgentConnectionContext> {
		private terminalIdSeq = 0;
		private readonly terminalProcesses = new Map<number, SupervisorTerminalProcess>();
		private readonly aliasToId = new Map<string, number>();
		private readonly bufferer = new TerminalDataBufferer(
			(id, data) => {
				const terminalProcess = this.terminalProcesses.get(id);
				if (terminalProcess) {
					terminalProcess['_onEvent'].fire({
						type: 'data',
						data
					});
				}
			}
		);
		private readonly layoutInfo = new Map<string, ITerminalTabLayoutInfoById[]>();
		private createTerminalProcess(
			initialCwd: string,
			workspaceId: string,
			workspaceName: string,
			shouldPersistTerminal: boolean,
			openOptions?: OpenSupervisorTerminalProcessOptions
		): SupervisorTerminalProcess {
			const terminalProcess = new SupervisorTerminalProcess(
				this.terminalIdSeq++,
				terminalServiceClient,
				initialCwd,
				workspaceId,
				workspaceName,
				shouldPersistTerminal,
				openOptions
			);
			this.terminalProcesses.set(terminalProcess.id, terminalProcess);
			terminalProcess.add({
				dispose: () => {
					this.terminalProcesses.delete(terminalProcess.id);
				}
			});
			this.bufferer.startBuffering(terminalProcess.id, terminalProcess.onProcessData);
			terminalProcess.add({
				dispose: () => {
					this.bufferer.stopBuffering(terminalProcess.id);
				}
			});
			return terminalProcess;
		}
		private attachTerminalProcess(terminalProcess: SupervisorTerminalProcess): void {
			const alias = terminalProcess.alias;
			if (!alias) {
				return;
			}
			this.aliasToId.set(alias, terminalProcess.id);
			terminalProcess.add({ dispose: () => this.aliasToId.delete(alias) });
		}
		async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
			if (command === '$createTerminalProcess') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const args = transformIncomingURIs(arg as ICreateTerminalProcessArguments, uriTranformer);
				const shellLaunchConfigDto = args.shellLaunchConfig;
				// see  $spawnExtHostProcess in src/vs/workbench/api/node/extHostTerminalService.ts for a reference implementation
				const shellLaunchConfig: IShellLaunchConfig = {
					name: shellLaunchConfigDto.name,
					executable: shellLaunchConfigDto.executable,
					args: shellLaunchConfigDto.args,
					cwd: typeof shellLaunchConfigDto.cwd === 'string' ? shellLaunchConfigDto.cwd : URI.revive(shellLaunchConfigDto.cwd),
					env: shellLaunchConfigDto.env
				};

				let lastActiveWorkspace: IWorkspaceFolder | undefined;
				if (args.activeWorkspaceFolder) {
					lastActiveWorkspace = toWorkspaceFolder(args.activeWorkspaceFolder);
				}

				const procesEnv = { ...process.env, ...args.resolverEnv } as platform.IProcessEnvironment;
				const variableResolver = new RemoteTerminalVariableResolverService(
					args.workspaceFolders.map(toWorkspaceFolder),
					args.resolvedVariables,
					args.activeFileResource ? URI.revive(args.activeFileResource) : undefined,
					procesEnv
				);

				// Merge in shell and args from settings
				if (!shellLaunchConfig.executable) {
					shellLaunchConfig.executable = terminalEnvironment.getDefaultShell(
						key => args.configuration[key],
						args.isWorkspaceShellAllowed,
						getSystemShellSync(platform.platform),
						process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432'),
						process.env.windir,
						terminalEnvironment.createVariableResolver(lastActiveWorkspace, variableResolver),
						logService,
						false
					);
					shellLaunchConfig.args = terminalEnvironment.getDefaultShellArgs(
						key => args.configuration[key],
						args.isWorkspaceShellAllowed,
						false,
						terminalEnvironment.createVariableResolver(lastActiveWorkspace, variableResolver),
						logService
					);
				} else {
					shellLaunchConfig.executable = variableResolver.resolve(lastActiveWorkspace, shellLaunchConfig.executable);
					if (shellLaunchConfig.args) {
						if (Array.isArray(shellLaunchConfig.args)) {
							const resolvedArgs: string[] = [];
							for (const arg of shellLaunchConfig.args) {
								resolvedArgs.push(variableResolver.resolve(lastActiveWorkspace, arg));
							}
							shellLaunchConfig.args = resolvedArgs;
						} else {
							shellLaunchConfig.args = variableResolver.resolve(lastActiveWorkspace, shellLaunchConfig.args);
						}
					}
				}

				// Get the initial cwd
				const initialCwd = terminalEnvironment.getCwd(
					shellLaunchConfig,
					os.homedir(),
					terminalEnvironment.createVariableResolver(lastActiveWorkspace, variableResolver),
					lastActiveWorkspace?.uri,
					args.configuration['terminal.integrated.cwd'], logService
				);
				shellLaunchConfig.cwd = initialCwd;

				const envFromConfig = args.configuration['terminal.integrated.env.linux'];
				const baseEnv = args.configuration['terminal.integrated.inheritEnv'] ? procesEnv : await getMainProcessParentEnv(procesEnv);
				const env = terminalEnvironment.createTerminalEnvironment(
					shellLaunchConfig,
					envFromConfig,
					terminalEnvironment.createVariableResolver(lastActiveWorkspace, variableResolver),
					args.isWorkspaceShellAllowed,
					product.version,
					args.configuration['terminal.integrated.detectLocale'] || 'auto',
					baseEnv
				);

				// Apply extension environment variable collections to the environment
				if (!shellLaunchConfig.strictEnv) {
					const collection = new Map<string, IEnvironmentVariableCollection>();
					for (const [name, serialized] of args.envVariableCollections) {
						collection.set(name, {
							map: deserializeEnvironmentVariableCollection(serialized)
						});
					}
					const mergedCollection = new MergedEnvironmentVariableCollection(collection);
					mergedCollection.applyToProcessEnvironment(env);
				}

				const terminalProcess = this.createTerminalProcess(
					initialCwd,
					args.workspaceId,
					args.workspaceName,
					args.shouldPersistTerminal,
					{
						shell: shellLaunchConfig.executable!,
						shellArgs: typeof shellLaunchConfig.args === 'string' ? [shellLaunchConfig.args] : shellLaunchConfig.args || [],
						cols: args.cols,
						rows: args.rows,
						env
					});
				const result: ICreateTerminalProcessResult = {
					terminalId: terminalProcess.id,
					resolvedShellLaunchConfig: shellLaunchConfig
				};
				return transformOutgoingURIs(result, uriTranformer);
			}
			if (command === '$startTerminalProcess') {
				const args: IStartTerminalProcessArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					return <ITerminalLaunchError>{
						message: 'terminal not found'
					};
				}
				const result = await terminalProcess.start();
				this.attachTerminalProcess(terminalProcess);
				return result;
			}
			if (command === '$shutdownTerminalProcess') {
				const args: IShutdownTerminalProcessArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.shutdown(args.immediate);
			}
			if (command === '$sendInputToTerminalProcess') {
				const args: ISendInputToTerminalProcessArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.input(args.data);
			}
			if (command === '$resizeTerminalProcess') {
				const args: IResizeTerminalProcessArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.resize(args.cols, args.rows);
			}
			if (command === '$getTerminalInitialCwd') {
				const args: IGetTerminalInitialCwdArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.getInitialCwd();
			}
			if (command === '$getTerminalCwd') {
				const args: IGetTerminalCwdArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.getCwd();
			}
			if (command === '$sendCharCountToTerminalProcess') {
				const args: ISendCharCountToTerminalProcessArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.acknowledgeDataEvent(args.charCount);
			}
			/*if (command === '$sendCommandResultToTerminalProcess') {
				const args: ISendCommandResultToTerminalProcessArguments = arg;
				return;
			}
			if (command === '$orphanQuestionReply') {
				const args: IOrphanQuestionReplyArgs = arg;
				return;
			}*/
			if (command === '$listTerminals') {
				try {
					const result: IRemoteTerminalDescriptionDto[] = [];
					const tasks = await synchingTasks;
					const response = await util.promisify<ListTerminalsRequest, ListTerminalsResponse>(terminalServiceClient.list.bind(terminalServiceClient))(new ListTerminalsRequest());
					for (const terminal of response.getTerminalsList()) {
						const alias = terminal.getAlias();
						const id = this.aliasToId.get(alias);
						const annotations = terminal.getAnnotationsMap();
						const workspaceId = annotations.get('workspaceId') || '';
						const workspaceName = annotations.get('workspaceName') || '';
						const shouldPersistTerminal = tasks.has(alias) || Boolean(annotations.get('shouldPersistTerminal'));
						let terminalProcess: SupervisorTerminalProcess | undefined;
						if (!id) {
							terminalProcess = this.createTerminalProcess(
								terminal.getInitialWorkdir(),
								workspaceId,
								workspaceName,
								shouldPersistTerminal
							);
							this.terminalProcesses.set(terminalProcess.id, terminalProcess);

							terminalProcess.alias = alias;
							this.attachTerminalProcess(terminalProcess);
						} else {
							terminalProcess = this.terminalProcesses.get(id);
						}
						if (!terminalProcess) {
							continue;
						}

						result.push({
							id: terminalProcess.id,
							cwd: terminal.getCurrentWorkdir(),
							pid: terminal.getPid(),
							title: terminal.getTitle(),
							workspaceId,
							workspaceName,
							isOrphan: true
						});
					}

					return result;
				} catch (e) {
					console.error('code server: failed to list remote terminals:', e);
					return [];
				}
			}
			if (command === '$getTerminalLayoutInfo') {
				try {
					const args: IGetTerminalLayoutInfoArgs = arg;

					const tasks = await synchingTasks;
					const response = await util.promisify<ListTerminalsRequest, ListTerminalsResponse>(terminalServiceClient.list.bind(terminalServiceClient))(new ListTerminalsRequest());
					const workspaceTerminals = new Set<number>();
					const targets = new Map<number, IRemoteTerminalAttachTarget>();
					for (const terminal of response.getTerminalsList()) {
						const alias = terminal.getAlias();
						const id = this.aliasToId.get(alias);
						const annotations = terminal.getAnnotationsMap();
						const workspaceId = annotations.get('workspaceId') || '';
						const workspaceName = annotations.get('workspaceName') || '';
						const shouldPersistTerminal = tasks.has(alias) || Boolean(annotations.get('shouldPersistTerminal'));
						let terminalProcess: SupervisorTerminalProcess | undefined;
						if (!id) {
							terminalProcess = this.createTerminalProcess(
								terminal.getInitialWorkdir(),
								workspaceId,
								workspaceName,
								shouldPersistTerminal
							);
							this.terminalProcesses.set(terminalProcess.id, terminalProcess);

							terminalProcess.alias = alias;
							this.attachTerminalProcess(terminalProcess);
						} else {
							terminalProcess = this.terminalProcesses.get(id);
						}
						if (!terminalProcess) {
							continue;
						}

						if (workspaceId === args.workspaceId) {
							workspaceTerminals.add(terminalProcess.id);
						}
						if (workspaceId === args.workspaceId || tasks.has(alias)) {
							targets.set(terminalProcess.id, {
								id: terminalProcess.id,
								cwd: terminal.getCurrentWorkdir(),
								pid: terminal.getPid(),
								title: terminal.getTitle(),
								workspaceId,
								workspaceName,
								isOrphan: true
							});
						}
					}

					const result: ITerminalsLayoutInfo = { tabs: [] };
					if (this.layoutInfo.has(args.workspaceId)) {
						// restoring layout
						for (const tab of this.layoutInfo.get(args.workspaceId)!) {
							result.tabs.push({
								...tab,
								terminals: tab.terminals.map(terminal => {
									const target = targets.get(terminal.terminal) || null;
									return {
										...terminal,
										terminal: target
									};
								})
							});
						}
					} else {
						// initial layout
						type Tab = IRawTerminalTabLayoutInfo<IRemoteTerminalAttachTarget | null>;
						let currentTab: Tab | undefined;
						let currentTerminal: IRemoteTerminalAttachTarget | undefined;
						const layoutTerminal = (terminal: IRemoteTerminalAttachTarget, mode: TerminalOpenMode = defaultOpenMode) => {
							if (!currentTab) {
								currentTab = {
									isActive: false,
									activeTerminalProcessId: terminal.id,
									terminals: [{ relativeSize: 1, terminal }]
								};
								result.tabs.push(currentTab);
							} else if (mode === 'tab-after' || mode === 'tab-before') {
								const tab: Tab = {
									isActive: false,
									activeTerminalProcessId: terminal.id,
									terminals: [{ relativeSize: 1, terminal }]
								};
								const currentIndex = result.tabs.indexOf(currentTab);
								const direction = mode === 'tab-after' ? 1 : -1;
								result.tabs.splice(currentIndex + direction, 0, tab);
								currentTab = tab;
							} else {
								currentTab.activeTerminalProcessId = terminal.id;
								let currentIndex = -1;
								const relativeSize = 1 / (currentTab.terminals.length + 1);
								currentTab.terminals.forEach((info, index) => {
									info.relativeSize = relativeSize;
									if (info.terminal === currentTerminal) {
										currentIndex = index;
									}
								});
								const direction = (mode === 'split-right' || mode === 'split-bottom') ? 1 : -1;
								currentTab.terminals.splice(currentIndex + direction, 0, { relativeSize, terminal });
							}
							currentTerminal = terminal;
						};
						for (const [alias, status] of tasks) {
							const id = this.aliasToId.get(alias);
							const terminal = typeof id === 'number' && targets.get(id);
							if (terminal) {
								layoutTerminal(terminal, asTerminalOpenMode(status.getPresentation()?.getOpenMode()));
							}
						}
						for (const id of workspaceTerminals) {
							const terminal = targets.get(id);
							if (terminal) {
								layoutTerminal(terminal);
							}
						}
						if (currentTab) {
							currentTab.isActive = true;
						}
					}

					return result;
				} catch (e) {
					console.error('code server: failed to get terminal layout info:', e);
					return [];
				}
			}
			if (command === '$setTerminalLayoutInfo') {
				const args: ISetTerminalLayoutInfoArgs = arg;
				this.layoutInfo.set(args.workspaceId, args.tabs);
				return;
			}
			console.error('Unknown command: RemoteTerminalChannel.' + command);
			throw new Error('Unknown command: RemoteTerminalChannel.' + command);
		}
		listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
			if (event === '$onTerminalProcessEvent') {
				const args: IOnTerminalProcessEventArguments = arg;
				const terminalProcess = this.terminalProcesses.get(args.id);
				if (!terminalProcess) {
					throw new Error('terminal not found');
				}
				return terminalProcess.onEvent;
			}
			console.error('Unknown event: RemoteTerminalChannel.' + event);
			throw new Error('Unknown event: RemoteTerminalChannel.' + event);
		}
	}
	channelServer.registerChannel('remoteterminal', new RemoteTerminalChannelServer());

	const fileService = new FileService(logService);
	const diskFileSystemProvider = new DiskFileSystemProvider(logService);
	fileService.registerProvider(Schemas.file, diskFileSystemProvider);

	// see used APIs in src/vs/workbench/services/remote/common/remoteAgentFileSystemChannel.ts
	class RemoteFileSystem implements IServerChannel<RemoteAgentConnectionContext> {
		protected readonly watchers = new Map<string, {
			watcher: DiskFileSystemProvider,
			emitter: Emitter<IFileChangeDto[] | string>
		}>();
		protected readonly watchHandles = new Map<string, IDisposable>();
		async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
			if (command === 'stat') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.stat(URI.revive(uriTranformer.transformIncoming(arg[0])));
			}
			if (command === 'open') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.open(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
			}
			if (command === 'close') {
				return diskFileSystemProvider.close(arg[0]);
			}
			if (command === 'read') {
				const length = arg[2];
				const data = VSBuffer.alloc(length);
				const read = await diskFileSystemProvider.read(arg[0], arg[1], data.buffer, 0, length);
				return [read, data.slice(0, read)];
			}
			if (command === 'readFile') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const data = await diskFileSystemProvider.readFile(URI.revive(uriTranformer.transformIncoming(arg[0])));
				return VSBuffer.wrap(data);
			}
			if (command === 'write') {
				const data = arg[2] as VSBuffer;
				await diskFileSystemProvider.write(arg[0], arg[1], data.buffer, arg[3], arg[4]);
				return;
			}
			if (command === 'writeFile') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const data = arg[1] as VSBuffer;
				await diskFileSystemProvider.writeFile(URI.revive(uriTranformer.transformIncoming(arg[0])), data.buffer, arg[2]);
				return;
			}
			if (command === 'delete') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				await diskFileSystemProvider.delete(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
				return;
			}
			if (command === 'mkdir') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				await diskFileSystemProvider.mkdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
				return;
			}
			if (command === 'readdir') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.readdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
			}
			if (command === 'rename') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.rename(
					URI.revive(uriTranformer.transformIncoming(arg[0])),
					URI.revive(uriTranformer.transformIncoming(arg[1])),
					arg[2]
				);
			}
			if (command === 'copy') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				return diskFileSystemProvider.copy(
					URI.revive(uriTranformer.transformIncoming(arg[0])),
					URI.revive(uriTranformer.transformIncoming(arg[1])),
					arg[2]
				);
			}
			if (command === 'watch') {
				const watcher = this.watchers.get(arg[0])?.watcher;
				if (watcher) {
					const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
					const unwatch = watcher.watch(URI.revive(uriTranformer.transformIncoming(arg[2])), arg[3]);
					this.watchHandles.set(
						arg[0] + ':' + arg[1],
						unwatch
					);
				} else {
					console.error(`'filechange' event should be called before 'watch' first request`);
				}
				return;
			}
			if (command === 'unwatch') {
				this.watchHandles.get(arg[0] + ':' + arg[1])?.dispose();
				this.watchHandles.delete(arg[0] + ':' + arg[1]);
				return;
			}
			console.error('Unknown command: RemoteFileSystem.' + command);
			throw new Error('Unknown command: RemoteFileSystem.' + command);
		}
		protected obtainFileChangeEmitter(ctx: RemoteAgentConnectionContext, session: string): Emitter<IFileChangeDto[] | string> {
			let existing = this.watchers.get(session);
			if (existing) {
				return existing.emitter;
			}
			const watcher = new DiskFileSystemProvider(logService);
			const emitter = new Emitter<IFileChangeDto[] | string>({
				onLastListenerRemove: () => {
					this.watchers.delete(session);
					emitter.dispose();
					watcher.dispose();
					console.log(`[session:${session}] closed watching fs`);
				}
			});
			console.log(`[session:${session}] started watching fs`);
			this.watchers.set(session, { watcher, emitter });

			const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
			watcher.onDidChangeFile(changes => emitter.fire(
				changes.map(change => ({
					resource: uriTranformer.transformOutgoingURI(change.resource),
					type: change.type
				} as IFileChangeDto))
			));
			watcher.onDidErrorOccur(error => emitter.fire(error));
			return emitter;
		}
		listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
			if (event === 'filechange') {
				return this.obtainFileChangeEmitter(ctx, arg[0]).event;
			}
			if (event === 'readFileStream') {
				const uriTranformer = new URITransformer(rawURITransformerFactory(ctx.remoteAuthority));
				const resource = URI.revive(transformIncomingURIs(arg[0], uriTranformer));
				const emitter = new Emitter<ReadableStreamEventPayload<VSBuffer>>({
					onLastListenerRemove: () => {
						cancellationTokenSource.cancel();
					}
				});
				const cancellationTokenSource = new CancellationTokenSource();
				const stream = diskFileSystemProvider.readFileStream(resource, arg[1], cancellationTokenSource.token);
				stream.on('data', data => emitter.fire(VSBuffer.wrap(data)));
				stream.on('error', error => emitter.fire(error));
				stream.on('end', () => {
					emitter.fire('end');
					emitter.dispose();
					cancellationTokenSource.dispose();
				});
				return emitter.event;
			}
			console.error('Unknown event: RemoteFileSystem.' + event);
			throw new Error('Unknown event: RemoteFileSystem.' + event);
		}
	}
	channelServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new RemoteFileSystem());

	const services = new ServiceCollection();
	services.set(IEnvironmentService, environmentService);
	services.set(INativeEnvironmentService, environmentService);
	services.set(ILogService, logService);
	services.set(ITelemetryService, NullTelemetryService);

	services.set(IFileService, fileService);

	services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [environmentService.settingsResource, fileService]));
	services.set(IProductService, { _serviceBrand: undefined, ...product });
	services.set(IRequestService, new SyncDescriptor(RequestService));
	services.set(IDownloadService, new SyncDescriptor(DownloadService));

	services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));
	services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));

	services.set(IRequestService, new SyncDescriptor(RequestService));

	let resolveExtensionsInstalled: (value?: unknown) => void;
	const extensionsInstalled = new Promise(resolve => resolveExtensionsInstalled = resolve);

	const instantiationService = new InstantiationService(services);
	instantiationService.invokeFunction(accessor => {
		const extensionManagementService = accessor.get(IExtensionManagementService);
		channelServer.registerChannel('extensions', new ExtensionManagementChannel(extensionManagementService, requestContext => new URITransformer(rawURITransformerFactory(requestContext))));
		installExtensionsFromServer(
			extensionManagementService,
			accessor.get(IRequestService),
			accessor.get(IFileService)
		).then(resolveExtensionsInstalled);
		(extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions();

		const requestService = accessor.get(IRequestService);
		channelServer.registerChannel('request', new RequestChannel(requestService));
	});

	const clients = new Map<string, Client>();

	const server = http.createServer(async (req, res) => {
		if (!req.url) {
			return serveError(req, res, 400, 'Bad Request.');
		}
		try {
			const parsedUrl = url.parse(req.url, true);
			const pathname = parsedUrl.pathname;

			//#region headless
			if (pathname === '/vscode-remote-resource') {
				if (parsedUrl.query['tkn'] !== connectionToken) {
					return serveError(req, res, 403, 'Forbidden.');
				}
				const filePath = parsedUrl.query['path'];
				const fsPath = typeof filePath === 'string' && URI.from({ scheme: 'file', path: filePath }).fsPath;
				if (!fsPath) {
					return serveError(req, res, 400, 'Bad Request.');
				}
				return serveFile(req, res, fsPath);
			}

			if (pathname === '/gitpod-cli-server-sockets') {
				const linkNames = await readdir(cliServerSocketsPath);
				const processes = new Set<string>();
				clients.forEach(client => {
					if (client.extensionHost) {
						processes.add(String(client.extensionHost.pid));
					}
				});
				const links: string[] = [];
				for (const linkName of linkNames) {
					const link = path.join(cliServerSocketsPath, linkName);
					if (processes.has(path.parse(link).name)) {
						try {
							const socket = await util.promisify(fs.realpath.bind(fs))(link);
							links.push(socket);
						} catch {
							/* no-op symlink is broken */
						}
					}
				}
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ links }));
			}

			if (devMode) {
				if (pathname === '/_supervisor/v1/environment/workspace') {
					const stat = await util.promisify(fs.stat)(process.env.THEIA_WORKSPACE_ROOT!);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({
						workspace_location: {
							file: stat.isFile() ? process.env.THEIA_WORKSPACE_ROOT : undefined,
							folder: stat.isDirectory() ? process.env.THEIA_WORKSPACE_ROOT : undefined
						},
						user_home: os.homedir()
					}));
				}
			}
			//#region headless end

			//#region static
			if (pathname === '/') {
				return serveFile(req, res, devMode ? WEB_MAIN_DEV : WEB_MAIN);
			}
			if (pathname === '/favicon.ico') {
				return serveFile(req, res, path.join(APP_ROOT, 'resources/gitpod/favicon.ico'));
			}
			if (pathname === '/manifest.json') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({
					'name': product.nameLong,
					'short_name': product.nameShort,
					'start_url': '/',
					'lang': 'en-US',
					'display': 'standalone'
				}));
			}
			if (pathname) {
				let relativeFilePath;
				if (/^\/static\//.test(pathname)) {
					relativeFilePath = path.normalize(decodeURIComponent(pathname.substr('/static/'.length)));
				} else {
					relativeFilePath = path.normalize(decodeURIComponent(pathname));
				}
				return serveFile(req, res, path.join(APP_ROOT, relativeFilePath));
			}
			//#region static end

			// TODO uri callbacks ?
			console.error(`${req.method} ${req.url} not found`);
			return serveError(req, res, 404, 'Not found.');
		} catch (error) {
			console.error(error);

			return serveError(req, res, 500, 'Internal Server Error.');
		}
	});
	server.on('error', console.error);
	server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
		if (req.headers['upgrade'] !== 'websocket' || !req.url) {
			console.error(`failed to upgrade for header "${req.headers['upgrade']}" and url: "${req.url}".`);
			socket.end('HTTP/1.1 400 Bad Request');
			return;
		}
		const { query } = url.parse(req.url, true);
		// /?reconnectionToken=c0e3a8af-6838-44fb-851b-675401030831&reconnection=false&skipWebSocketFrames=false
		const reconnection = 'reconnection' in query && query['reconnection'] === 'true';
		let token: string | undefined;
		if ('reconnectionToken' in query && typeof query['reconnectionToken'] === 'string') {
			token = query['reconnectionToken'];
		}
		// TODO skipWebSocketFrames (support of VS Code desktop?)
		if (!token) {
			console.error(`missing token for "${req.url}".`);
			socket.end('HTTP/1.1 400 Bad Request');
			return;
		}
		console.log(`[${token}] Socket upgraded for "${req.url}".`);
		socket.on('error', e => {
			console.error(`[${token}] Socket failed for "${req.url}".`, e);
		});

		const acceptKey = req.headers['sec-websocket-key'];
		const hash = crypto.createHash('sha1').update(acceptKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		const responseHeaders = ['HTTP/1.1 101 Web Socket Protocol Handshake', 'Upgrade: WebSocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${hash}`];

		let permessageDeflate = false;
		if (String(req.headers['sec-websocket-extensions']).indexOf('permessage-deflate') !== -1) {
			permessageDeflate = true;
			responseHeaders.push('Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=15');
		}

		socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

		const client = clients.get(token) || {};
		clients.set(token, client);

		const webSocket = new WebSocketNodeSocket(new NodeSocket(socket), permessageDeflate, null, permessageDeflate);
		const protocol = new PersistentProtocol(webSocket);
		const controlListener = protocol.onControlMessage(raw => {
			const msg = <HandshakeMessage>JSON.parse(raw.toString());
			if (msg.type === 'error') {
				console.error(`[${token}] error control message:`, msg.reason);
				safeDisposeProtocolAndSocket(protocol);
			} else if (msg.type === 'auth') {
				protocol.sendControl(VSBuffer.fromString(JSON.stringify({
					type: 'sign',
					data: 'Gitpod Code Server'
				} as SignRequest)));
			} else if (msg.type === 'connectionType') {
				controlListener.dispose();
				// TODO version matching msg.commit
				// TODO auth check msg.signedData
				for (const [token, client] of clients) {
					if (client.management) {
						if (client.management.graceTimeReconnection.isScheduled() && !client.management.shortGraceTimeReconnection.isScheduled()) {
							console.log(`[${token}] Another connection is established, closing this connection after ${ProtocolConstants.ReconnectionShortGraceTime}ms reconnection timeout.`);
							client.management.shortGraceTimeReconnection.schedule();
						}
					}
					if (client.extensionHost) {
						client.extensionHost.send({
							type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
						});
					}
				}
				if (msg.desiredConnectionType === ConnectionType.Management) {
					if (!reconnection) {
						if (client.management) {
							console.error(`[${token}] Falied to connect: management connection is already running.`);
							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Management connection is already running.' } as ErrorMessage)));
							safeDisposeProtocolAndSocket(protocol);
							return;
						}

						const onDidClientDisconnectEmitter = new Emitter<void>();
						let disposed = false;
						function dispose(): void {
							if (disposed) {
								return;
							}
							disposed = true;
							graceTimeReconnection.dispose();
							shortGraceTimeReconnection.dispose();
							client.management = undefined;
							protocol.sendDisconnect();
							const socket = protocol.getSocket();
							protocol.dispose();
							socket.end();
							onDidClientDisconnectEmitter.fire(undefined);
							onDidClientDisconnectEmitter.dispose();
							console.log(`[${token}] Management connection is disposed.`);
						}

						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' } as OKMessage)));
						const graceTimeReconnection = new RunOnceScheduler(() => {
							console.log(`[${token}] Management connection expired after ${ProtocolConstants.ReconnectionGraceTime}ms (grace).`);
							dispose();
						}, ProtocolConstants.ReconnectionGraceTime);
						const shortGraceTimeReconnection = new RunOnceScheduler(() => {
							console.log(`[${token}] Management connection expired after ${ProtocolConstants.ReconnectionGraceTime}ms (short grace).`);
							dispose();
						}, ProtocolConstants.ReconnectionShortGraceTime);
						client.management = { protocol, graceTimeReconnection, shortGraceTimeReconnection };
						protocol.onDidDispose(() => dispose());
						protocol.onSocketClose(() => {
							console.log(`[${token}] Management connection socket is closed, waiting to reconnect within ${ProtocolConstants.ReconnectionGraceTime}ms.`);
							graceTimeReconnection.schedule();
						});
						onDidClientConnectEmitter.fire({ protocol, onDidClientDisconnect: onDidClientDisconnectEmitter.event });
						console.log(`[${token}] Management connection is connected.`);
					} else {
						if (!client.management) {
							console.error(`[${token}] Failed to reconnect: management connection is not running.`);
							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Management connection is not running.' } as ErrorMessage)));
							safeDisposeProtocolAndSocket(protocol);
							return;
						}

						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' } as OKMessage)));
						client.management.graceTimeReconnection.cancel();
						client.management.shortGraceTimeReconnection.cancel();
						client.management.protocol.beginAcceptReconnection(protocol.getSocket(), protocol.readEntireBuffer());
						client.management.protocol.endAcceptReconnection();
						protocol.dispose();
						console.log(`[${token}] Management connection is reconnected.`);
					}
				} else if (msg.desiredConnectionType === ConnectionType.ExtensionHost) {
					const params: IRemoteExtensionHostStartParams = {
						language: 'en',
						...msg.args
						// TODO what if params.port is 0?
					};

					if (!reconnection) {
						if (client.extensionHost) {
							console.error(`[${token}] Falied to connect: extension host is already running.`);
							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Extension host is already running.' } as ErrorMessage)));
							safeDisposeProtocolAndSocket(protocol);
							return;
						}

						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ debugPort: params.port } /* Omit<IExtensionHostConnectionResult, 'protocol'> */)));
						const initialDataChunk = Buffer.from(protocol.readEntireBuffer().buffer).toString('base64');
						protocol.dispose();
						socket.pause();

						try {
							// see src/vs/workbench/services/extensions/electron-browser/localProcessExtensionHost.ts
							const opts: cp.ForkOptions = {
								env: {
									...process.env,
									VSCODE_AMD_ENTRYPOINT: 'vs/workbench/services/extensions/node/extensionHostProcess',
									VSCODE_PIPE_LOGGING: 'true',
									VSCODE_VERBOSE_LOGGING: 'true',
									VSCODE_LOG_NATIVE: 'false',
									VSCODE_EXTHOST_WILL_SEND_SOCKET: 'true',
									VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
									VSCODE_LOG_STACK: 'true',
									VSCODE_LOG_LEVEL: environmentService.verbose ? 'trace' : environmentService.logLevel,
									GITPOD_CLI_SERVER_SOCKETS_PATH: cliServerSocketsPath
								},
								// see https://github.com/akosyakov/gitpod-code/blob/33b49a273f1f6d44f303426b52eaf89f0f5cc596/src/vs/base/parts/ipc/node/ipc.cp.ts#L72-L78
								execArgv: [],
								silent: true
							};
							if (typeof params.port === 'number') {
								if (params.port !== 0) {
									opts.execArgv = [
										'--nolazy',
										(params.break ? '--inspect-brk=' : '--inspect=') + params.port
									];
								} else {
									// TODO we should return a dynamically allocated port to the client,
									// it is better to avoid it?
									opts.execArgv = ['--inspect-port=0'];
								}
							}
							const extensionHost = cp.fork(getPathFromAmdModule(require, 'bootstrap-fork'), ['--type=extensionHost', '--uriTransformerPath=' + uriTransformerPath], opts);
							extensionHost.stdout!.setEncoding('utf8');
							extensionHost.stderr!.setEncoding('utf8');
							Event.fromNodeEventEmitter<string>(extensionHost.stdout!, 'data')(msg => console.log(`[${token}][extension host][${extensionHost.pid}][stdout] ${msg}`));
							Event.fromNodeEventEmitter<string>(extensionHost.stderr!, 'data')(msg => console.log(`[${token}][extension host][${extensionHost.pid}][stderr] ${msg}`));
							extensionHost.on('message', msg => {
								if (msg && (<IRemoteConsoleLog>msg).type === '__$console') {
									console.log(`[${token}][extension host][${extensionHost.pid}][__$console] ${(<IRemoteConsoleLog>msg).arguments}`);
								}
							});

							let disposed = false;
							function dispose(): void {
								if (disposed) {
									return;
								}
								disposed = true;
								socket.end();
								extensionHost.kill();
								client.extensionHost = undefined;

								unlink(path.join(cliServerSocketsPath, extensionHost.pid + '.socket')).catch(e => {
									console.error('Failed to unlink cli server socket:', e);
								});
							}

							extensionHost.on('error', err => {
								dispose();
								console.error(`[${token}] Extension host failed with: `, err);
							});
							extensionHost.on('exit', (code: number, signal: string) => {
								dispose();
								if (code !== 0 && signal !== 'SIGTERM') {
									console.error(`[${token}] Extension host exited with code: ${code} and signal: ${signal}.`);
								}
							});

							const readyListener = (msg: any) => {
								if (msg && (<IExtHostReadyMessage>msg).type === 'VSCODE_EXTHOST_IPC_READY') {
									extensionHost.removeListener('message', readyListener);
									const inflateBytes = Buffer.from(webSocket.recordedInflateBytes.buffer).toString('base64');
									extensionHost.send({
										type: 'VSCODE_EXTHOST_IPC_SOCKET',
										initialDataChunk,
										skipWebSocketFrames: false, // TODO skipWebSocketFrames - i.e. when we connect from Node (VS Code?)
										permessageDeflate,
										inflateBytes
									} as IExtHostSocketMessage, socket);
									console.log(`[${token}] Extension host is connected.`);
								}
							};
							extensionHost.on('message', readyListener);
							client.extensionHost = extensionHost;
							console.log(`[${token}] Extension host is started.`);
						} catch (e) {
							console.error(`[${token}] Failed to start the extension host process: `, e);
						}
					} else {
						if (!client.extensionHost) {
							console.error(`[${token}] Failed to reconnect: extension host is not running.`);
							protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Extension host is not running.' } as ErrorMessage)));
							safeDisposeProtocolAndSocket(protocol);
							return;
						}

						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ debugPort: params.port } /* Omit<IExtensionHostConnectionResult, 'protocol'> */)));
						const initialDataChunk = Buffer.from(protocol.readEntireBuffer().buffer).toString('base64');
						protocol.dispose();
						socket.pause();

						const inflateBytes = Buffer.from(webSocket.recordedInflateBytes.buffer).toString('base64');
						client.extensionHost.send({
							type: 'VSCODE_EXTHOST_IPC_SOCKET',
							initialDataChunk,
							skipWebSocketFrames: false, // TODO skipWebSocketFrames - i.e. when we connect from Node (VS Code?)
							permessageDeflate,
							inflateBytes
						} as IExtHostSocketMessage, socket);
						console.log(`[${token}] Extension host is reconnected.`);
					}
				} else {
					console.error(`[${token}] Unexpected connection type:`, msg.desiredConnectionType);
					safeDisposeProtocolAndSocket(protocol);
				}
			} else {
				console.error(`[${token}] Unexpected control message:`, msg.type);
				safeDisposeProtocolAndSocket(protocol);
			}
		});
	});
	let port = 3000;
	if (!devMode && process.env.GITPOD_THEIA_PORT) {
		port = Number(process.env.GITPOD_THEIA_PORT);
	}
	server.listen(port, '0.0.0.0', () => {
		const { address, port } = server.address() as net.AddressInfo;
		console.log(`Gitpod Code Server listening on ${address}:${port}.`);
	});
}
main();
