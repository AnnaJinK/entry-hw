const { app, ipcMain, shell } = require('electron');
const path = require('path');
const ScannerManager = require('./scannerManager');
const Flasher = require('./serial/flasher');
const rendererConsole = require('./utils/rendererConsole');
const IpcManager = require('./utils/ipcMainManager');
const HardwareListManager = require('./hardwareListManager');
const HandlerCreator = require('./datahandler/handler');

/**
 * scanner, server, connector 를 총괄하는 중앙 클래스.
 * 해당 클래스는 renderer 의 router 와 통신한다.
 * 아래의 클래스들은 ipc 통신을 하지 않는다.
 *
 * scanner : 포트 검색 과 종료
 * server : entry workspace 와 통신하는 http/ws 서버
 * connector : 연결 성공 후의 실제 시리얼포트
 */
class MainRouter {
    get roomIds() {
        return global.sharedObject.roomIds || [];
    }

    constructor(mainWindow, entryServer) {
        global.$ = require('lodash');
        rendererConsole.initialize(mainWindow);
        this.ipcManager = new IpcManager(mainWindow);
        this.browser = mainWindow;
        this.scannerManager = new ScannerManager(this);
        this.server = entryServer;
        this.flasher = new Flasher();
        this.hardwareListManager = new HardwareListManager(this);

        this.selectedPort = undefined;
        this.config = undefined;
        this.scanner = undefined;
        /** @type {Connector} */
        this.connector = undefined;
        this.hwModule = undefined;
        /** @type {Object} */
        this.handler = undefined;

        entryServer.setRouter(this);
        this.server.open();

        this._resetIpcEvents();
        this._registerIpcEvents();
    }

    /**
     * 펌웨어를 업로드한다.
     * 펌웨어는 커넥터가 닫힌 상태에서 작업되어야 한다. (COMPort 점유)
     * 실패시 tryFlasherNumber 만큼 반복한다. 기본값은 10번이다.
     * 로직 종료시 재스캔하여 연결을 수립한다.
     * @param firmwareName 다중 펌웨어 존재시 펌웨어명을 명시
     * @returns {Promise<void|Error>}
     */
    flashFirmware(firmwareName) {
        const connectorSerialPort = this.connector && this.connector.serialPort;
        // firmware type 이 copy 인 경우는 시리얼포트를 경유하지 않으므로 체크하지 않는다.
        // 그러나 config 은 필요하다.
        if (
            this.config &&
            (firmwareName.type === 'copy' || connectorSerialPort)
        ) {
            this.sendState('flash');
            let firmware = firmwareName;
            const {
                firmware: firmwareInConfig,
                firmwareBaudRate: baudRate,
                firmwareMCUType: MCUType,
                tryFlasherNumber: maxFlashTryCount = 10,
            } = this.config;
            const lastSerialPortCOMPort = connectorSerialPort && connectorSerialPort.path;
            this.firmwareTryCount = 0;

            if (!firmwareName || firmwareName === '') {
                console.warn('firmware requested without firmware info!');
                console.warn('try to default firmware info in config file');
                firmware = firmwareInConfig;
            }

            this.close({ saveSelectedPort: true }); // 서버 통신 중지, 시리얼포트 연결 해제

            const flashFunction = () => new Promise((resolve, reject) => {
                setTimeout(() => {
                    //연결 해제 완료시간까지 잠시 대기 후 로직 수행한다.
                    this.flasher.flash(firmware, lastSerialPortCOMPort, { baudRate, MCUType })
                        .then(([error, ...args]) => {
                            if (error) {
                                rendererConsole.error('flashError', error, ...args);
                                if (error === 'exit') {
                                    // 에러 메세지 없이 프로세스 종료
                                    reject(new Error());
                                } else if (++this.firmwareTryCount <= maxFlashTryCount) {
                                    setTimeout(() => {
                                        flashFunction().then(resolve);
                                    }, 100);
                                } else {
                                    reject(new Error('Failed Firmware Upload'));
                                }
                            } else {
                                resolve(firmware);
                            }
                        })
                        .catch(reject);
                }, 500);
            });

            // 에러가 발생하거나, 정상종료가 되어도 일단 startScan 을 재시작한다.
            return flashFunction();
        } else {
            return Promise.reject(new Error('Hardware Device Is Not Connected'));
        }
    }

    /**
     * 연결을 끊고 새로 수립한다.
     * disconnect 혹은 lost state 상태이고, config 에 reconnect: true 인 경우 발생한다.
     * startScan 의 결과는 기다리지 않는다.
     */
    reconnect() {
        this.close();
        this.startScan(this.config);
    }

    /**
     * renderer 에 state 인자를 보낸다. 주로 ui 변경을 위해 사용된다.
     * @param {string} state 변경된 state
     * @param {...*} args 추가로 보낼 인자
     */
    sendState(state, ...args) {
        let resultState = state;
        if (state === 'lost' || state === 'disconnect') {
            if (this.config && this.config.reconnect) {
                this.reconnect();
            } else {
                // 연결 잃은 후 재연결 속성 없으면 연결해제처리
                resultState = 'disconnect';
                this.close();
            }
        }

        this.sendEventToMainWindow('state', resultState, ...args);
    }

    notifyCloudModeChanged(mode) {
        this.sendEventToMainWindow('cloudMode', mode);
        this.currentCloudMode = mode;
    }

    notifyServerRunningModeChanged(mode) {
        this.sendEventToMainWindow('serverMode', mode);
        this.currentServerRunningMode = mode;
    }

    sendEventToMainWindow(eventName, ...args) {
        if (!this.browser.isDestroyed()) {
            this.browser.webContents.send(eventName, ...args);
        }
    }

    /**
     * 현재 컴퓨터에 연결된 포트들을 검색한다.
     * 특정 시간(Scanner.SCAN_INTERVAL_MILLS) 마다 체크한다.
     * 연결성공시 'state' 이벤트가 발생된다.
     * @param config
     */
    async startScan(config) {
        try {
            this.config = config;
            if (this.scanner) {
                this.hwModule = require(`../../modules/${config.module}`);
                this.sendState('scan');
                this.scanner.stopScan();
                const connector = await this.scanner.startScan(this.hwModule, this.config);
                if (connector) {
                    this.connector = connector;
                    connector.setRouter(this);
                    this._connect(connector);
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    /**
     * 클라우드 모드 동작용.
     * 신규 클라이언트 소켓생성되어 호스트에 연결되는 경우,
     * 호스트 서버에서 관리하기 위해 해당 클라이언트용 roomId 를 추가한다.
     * @param roomId
     */
    addRoomId(roomId) {
        this.server.addRoomIdsOnSecondInstance(roomId);
    }

    stopScan() {
        if (this.scanner) {
            this.scanner.stopScan();
        }
        if (this.connector) {
            if (this.hwModule && this.hwModule.disconnect) {
                this.hwModule.disconnect(this.connector);
            } else {
                this.connector.close();
            }
            this.sendState('disconnected');
        }
    }

    /**
     * 연결이 정상적으로 된 경우 startScan 의 callback 에서 호출된다.
     * @param connector
     */
    _connect(connector) {
        this.connector = connector;

        /*
        해당 프로퍼티가 세팅된 경우는
        - flashfirmware 가 config 에 세팅되어있고,
        - 3000ms 동안 checkInitialData 가 정상적으로 이루어지지 않은 경우이다.
         */
        if (this.connector.executeFlash) {
            this.sendState('flash');
            delete this.connector.executeFlash;
            return;
        }

        // 엔트리측, 하드웨어측이 정상적으로 준비된 경우
        if (this.hwModule && this.server) {
            // 엔트리쪽으로 송수신시 변환할 방식. 현재 json 만 지원한다.
            this.handler = HandlerCreator.create(this.config);
            this._connectToServer();
            this.connector.connect(); // router 설정 후 실제 기기와의 통신 시작
        }
    }

    /**
     * 엔트리 워크스페이스와의 연결 담당 로직
     *
     * @private
     */
    _connectToServer() {
        const hwModule = this.hwModule;
        const server = this.server;

        if (hwModule.init) {
            hwModule.init(this.handler, this.config);
        }

        if (hwModule.setSocket) {
            hwModule.setSocket(server);
        }

        this.handleServerSocketConnected();
    }

    handleServerSocketConnected() {
        const hwModule = this.hwModule || {};
        const moduleConnected = this.connector && this.connector.serialPort;
        if (moduleConnected && hwModule.socketReconnection) {
            hwModule.socketReconnection();
        }
    }

    handleServerSocketClosed() {
        const hwModule = this.hwModule || {};
        const moduleConnected = this.connector && this.connector.serialPort;
        if (moduleConnected && hwModule.reset) {
            hwModule.reset();
        }
    }

    // 엔트리 측에서 데이터를 받아온 경우 전달
    handleServerData({ data, type }) {
        if (!this.hwModule || !this.handler || !this.config) {
            console.warn('hardware is not connected but entry server data is received');
            return;
        }

        const hwModule = this.hwModule;
        const handler = this.handler;
        const { direct } = this.config;

        if (direct && this.connector) {
            let result = data;
            if (hwModule.handleRemoteData) {
                result = hwModule.handleRemoteData(result);
            }
            if (hwModule.requestLocalData) {
                result = hwModule.requestLocalData(result);
            }
            this.connector.send(result);
        } else {
            handler.decode(data, type);
            if (hwModule.handleRemoteData) {
                hwModule.handleRemoteData(handler);
            }
        }
    }

    /**
     * 서버로 인코딩된 데이터를 보낸다.
     */
    sendEncodedDataToServer(data) {
        if (data) {
            this.server.send(data);
        } else {
            const data = this.handler && this.handler.encode();
            if (this.server && data) {
                this.server.send(data);
            }
        }
    }

    /**
     * 하드웨어 모듈의 requestRemoteData 를 통해 핸들러 내 데이터를 세팅한다.
     */
    setHandlerData() {
        if (this.hwModule.requestRemoteData) {
            this.hwModule.requestRemoteData(this.handler);
        }
    }

    setConnector(connector) {
        this.connector = connector;
    }

    /**
     *
     * @param option {Object=} true 인 경우, 포트선택했던 내역을 지우지 않는다.
     */
    close(option) {
        const { saveSelectedPort = false } = option || {};

        if (this.server) {
            this.server.disconnectHardware();
        }
        this.stopScan();
        this.hwModule = undefined;
        this.handler = undefined;

        if (!saveSelectedPort) {
            this.selectedPort = undefined;
        }
    };

    /**
     * 드라이버를 실행한다. 최초 실행시 app.asar 에 파일이 들어가있는 경우,
     * 외부로 복사하여 외부 파일을 사용한다.
     * @param driverPath
     */
    executeDriver(driverPath) {
        if (!this.config) {
            return;
        }

        const asarIndex = app.getAppPath().indexOf(`${path.sep}app.asar`);
        let sourcePath;
        if (asarIndex > -1) {
            sourcePath = path.join(app.getAppPath(), '..', 'drivers');
        } else {
            sourcePath = path.resolve(__dirname, '..', '..', 'drivers');
        }

        shell.openItem(path.resolve(sourcePath, driverPath));
    }

    _registerIpcEvents() {
        ipcMain.on('startScan', async (e, config) => {
            try {
                const { hardware: { type = '' } = {} } = config || {};
                this.scanner = this.scannerManager.getScanner(type);
                await this.startScan(config);
            } catch (e) {
                rendererConsole.error('startScan err : ', e);
            }
        });
        ipcMain.on('selectPort', (e, portName) => {
            this.selectedPort = portName;
        });
        ipcMain.on('stopScan', () => {
            this.stopScan();
        });
        ipcMain.on('close', () => {
            this.close();
        });
        ipcMain.on('requestFlash', (e, firmwareName) => {
            this.flashFirmware(firmwareName)
                .then((firmware) => {
                    if (!e.sender.isDestroyed()) {
                        e.sender.send('requestFlash');
                    }
                    return firmware;
                })
                .catch((err) => {
                    if (!e.sender.isDestroyed()) {
                        e.sender.send('requestFlash', err);
                    }
                })
                .then(async (firmware) => {
                    this.flasher.kill();
                    if (firmware && firmware.afterDelay) {
                        await new Promise((resolve) => setTimeout(resolve, firmware.afterDelay));
                    }
                    await this.startScan(this.config);
                });
        });
        ipcMain.on('executeDriver', (e, driverPath) => {
            this.executeDriver(driverPath);
        });
        ipcMain.on('getCurrentServerModeSync', (e) => {
            e.returnValue = this.currentServerRunningMode;
        });
        ipcMain.on('getCurrentCloudModeSync', (e) => {
            e.returnValue = this.currentCloudMode;
        });
        ipcMain.on('requestHardwareListSync', (e) => {
            e.returnValue = this.hardwareListManager.allHardwareList;
        });
    }

    _resetIpcEvents() {
        ipcMain.removeAllListeners('startScan');
        ipcMain.removeAllListeners('selectPort');
        ipcMain.removeAllListeners('stopScan');
        ipcMain.removeAllListeners('close');
        ipcMain.removeAllListeners('requestFlash');
        ipcMain.removeAllListeners('executeDriver');
        ipcMain.removeAllListeners('getCurrentServerModeSync');
        ipcMain.removeAllListeners('getCurrentCloudModeSync');
        ipcMain.removeAllListeners('requestHardwareListSync');
    }
}

module.exports = MainRouter;
