import createLogger from 'logging';
import debugLogger from 'debug';
import { isBrowser } from 'browser-or-node';
import uuid from 'uuid/v4';
import wrtc from 'wrtc';
import io from 'socket.io-client';
import SimplePeer from 'simple-peer';
import MewConnectCommon from '../MewConnectCommon';
import MewConnectCrypto from '../MewConnectCrypto';
import WebSocket from '../websocketWrapper';

const debug = debugLogger('MEWconnect:initiator');
const debugPeer = debugLogger('MEWconnectVerbose:peer-instances');
const debugStages = debugLogger('MEWconnect:initiator-stages');
const logger = createLogger('MewConnectInitiator');

export default class MewConnectInitiatorV1 extends MewConnectCommon {
  constructor(options = {}) {
    super('V1');

    try {
      this.supportedBrowser = MewConnectCommon.checkBrowser();
      this.uiCommunicator = options.uiCommunicator;

      this.activePeerId = '';
      this.allPeerIds = [];
      this.peersCreated = [];
      this.Url = options.url || 'wss://connect.mewapi.io';
      this.v2Url = options.v2Url || 'wss://connect2.mewapi.io/staging';

      this.turnTest = options.turnTest;

      this.p = null;
      this.socketConnected = false;
      this.connected = false;
      this.tryingTurn = false;
      this.turnDisabled = false;
      this.signalUrl = null;
      this.iceState = '';
      this.turnServers = [];

      this.webRtcCommunication = options.webRtcCommunication;
      // this.Peer = options.wrtc || SimplePeer; //WebRTCConnection
      // this.Peer = SimplePeer;
      // this.mewCrypto = options.cryptoImpl || MewConnectCrypto.create();

      this.io = io;
      this.connPath = '';

      this.signals = this.jsonDetails.signals;
      this.rtcEvents = this.jsonDetails.rtc;
      this.version = this.jsonDetails.version;
      this.versions = this.jsonDetails.versions;
      this.lifeCycle = this.jsonDetails.lifeCycle;
      this.stunServers = options.stunServers || this.jsonDetails.stunSrvers;
      this.iceStates = this.jsonDetails.iceConnectionState;
      // Socket is abandoned.  disconnect.
      this.timer = null;
      setTimeout(() => {
        if (this.socket) {
          this.socketDisconnect();
        }
      }, 120000);
      console.log(this.signals); // todo remove dev item
    } catch (e) {
      console.log(e); // todo remove dev item
      debug('constructor error:', e);
    }
  }

  setWebRtc(webRtcCommunication) {
    this.webRtcCommunication = webRtcCommunication;
  }

  // Initalize a websocket connection with the signal server
  async initiatorStart(url = this.Url, cryptoInstance, details) {
    try {
      this.mewCrypto = cryptoInstance;
      const toSign = this.mewCrypto.generateMessage();
      this.connId = details.connId;
      this.uiCommunicator(this.lifeCycle.signatureCheck);
      const options = {
        query: {
          stage: 'initiator',
          signed: details.signed,
          message: toSign,
          connId: this.connId
        },
        transports: ['websocket', 'polling', 'flashsocket'],
        secure: true
      };
      this.socketManager = this.io(url, options);
      this.socket = this.socketManager.connect();
      this.initiatorConnect(this.socket);
    } catch (e) {
      console.log(e);
    }
  }

  // ------------- WebSocket Communication Methods and Handlers ------------------------------

  // ----- Setup handlers for communication with the signal server
  initiatorConnect(socket) {
    debugStages('INITIATOR CONNECT');
    this.uiCommunicator(this.lifeCycle.SocketConnectedEvent);

    this.socket.on(this.signals.connect, () => {
      console.log(': SOCKET CONNECTED');
      this.socketConnected = true;
    });

    this.socketOn(this.signals.confirmation, this.beginRtcSequence.bind(this)); // response
    this.socketOn(this.signals.answer, this.recieveAnswer.bind(this));
    this.socketOn(
      this.signals.confirmationFailedBusy,
      this.busyFailure.bind(this)
    );
    this.socketOn(
      this.signals.confirmationFailed,
      this.confirmationFailure.bind(this)
    );
    this.socketOn(
      this.signals.invalidConnection,
      this.invalidFailure.bind(this)
    );
    this.socketOn(
      this.signals.disconnect,
      this.socketDisconnectHandler.bind(this)
    );
    this.socketOn(this.signals.attemptingTurn, this.willAttemptTurn.bind(this));
    this.socketOn(this.signals.turnToken, this.beginTurn.bind(this));
    return socket;
  }

  // ----- Wrapper around Socket.IO methods
  // socket.emit wrapper
  socketEmit(signal, data) {
    this.socket.binary(false).emit(signal, data);
  }

  // socket.disconnect wrapper
  socketDisconnect() {
    this.socket.disconnect();
    this.socketConnected = false;
  }

  // socket.on listener registration wrapper
  socketOn(signal, func) {
    this.socket.on(signal, func);
  }

  // ----- Socket Event handlers

  // Handle Socket Disconnect Event
  socketDisconnectHandler(reason) {
    debug(reason);
    this.socketConnected = false;
  }

  // Handle Socket Attempting Turn informative signal
  // Provide Notice that initial WebRTC connection failed and the fallback method will be used
  willAttemptTurn() {
    this.tryingTurn = true;
    debugStages('TRY TURN CONNECTION');
    this.uiCommunicator(this.lifeCycle.UsingFallback);
  }

  // Handle Socket event to initiate turn connection
  // Handle Receipt of TURN server details, and begin a WebRTC connection attempt using TURN
  beginTurn(data) {
    this.tryingTurn = true;
    this.retryViaTurn(data);
  }

  // ----- Failure Handlers

  // Handle Failure due to an attempt to join a connection with two existing endpoints
  busyFailure() {
    this.uiCommunicator(
      this.lifeCycle.Failed,
      this.lifeCycle.confirmationFailedBusyEvent
    );
    debug('confirmation Failed: Busy');
  }

  // Handle Failure due to no opposing peer existing
  invalidFailure() {
    this.uiCommunicator(
      this.lifeCycle.Failed,
      this.lifeCycle.invalidConnectionEvent
    );
    debug('confirmation Failed: no opposite peer found');
  }

  // Handle Failure due to the handshake/ verify details being invalid for the connection ID
  confirmationFailure() {
    this.uiCommunicator(
      this.lifeCycle.Failed,
      this.lifeCycle.confirmationFailedEvent
    );
    debug('confirmation Failed: invalid confirmation');
  }

  // =============== [End] WebSocket Communication Methods and Handlers ========================

  // ======================== [Start] WebRTC Communication Methods =============================

  // ----- WebRTC Setup Methods

  // A connection pair exists, create and send WebRTC OFFER
  async beginRtcSequence(data) {
    console.log(data); // todo remove dev item
    console.log('sendOffer: SOCKET CONFIRMATION');
    this.emit('beginRtcSequence', 'V1');
    // this.connPath = source;
    // const plainTextVersion = await this.mewCrypto.decrypt(data.version);
    // this.peerVersion = plainTextVersion;
    // this.uiCommunicator(this.lifeCycle.receiverVersion, plainTextVersion);
    debug('sendOffer', data);
    const options = {
      signalListener: this.initiatorSignalListener,
      webRtcConfig: {
        servers: this.stunServers
      }
    };
    this.initiatorStartRTC(this.socket, options);
  }

  initiatorStartRTC(socket, options) {
    console.log('initiatorStartRTC'); // todo remove dev item
    // this.setActivePeerId();
    const webRtcConfig = options.webRtcConfig || {};
    const signalListener = this.initiatorSignalListener(
      socket,
      webRtcConfig.servers
    );
    const webRtcServers = webRtcConfig.servers || this.stunServers;

    const suppliedOptions = options.webRtcOptions || {};

    const defaultOptions = {
      initiator: true,
      trickle: false,
      iceTransportPolicy: 'relay',
      config: {
        iceServers: webRtcServers
      },
      wrtc: wrtc
    };

    const simpleOptions = {
      ...defaultOptions,
      suppliedOptions
    };

    debug(`initiatorStartRTC - options: ${simpleOptions}`);
    this.webRtcCommunication.start(simpleOptions);
    this.uiCommunicator(this.lifeCycle.RtcInitiatedEvent);
    const peerID = this.webRtcCommunication.getActivePeerId();
    this.webRtcCommunication.on('connect', this.onConnect.bind(this, peerID));
    this.webRtcCommunication.on('signal', this.onSignal.bind(this));
    this.webRtcCommunication.on('data', this.onData.bind(this, peerID));
  }

  async onSignal(data) {
    console.log('onSignal'); // todo remove dev item
    console.log(data); // todo remove dev item
    const encryptedSend = await this.mewCrypto.encrypt(
      JSON.stringify(data)
    );
    this.uiCommunicator(this.lifeCycle.sendOffer);
    this.socketEmit(this.signals.offerSignal, {
      data: encryptedSend,
      connId: this.connId,
      options: this.stunServers
    });
  }

  initiatorSignalListener(socket, options) {
    return async data => {
      try {
        debug('SIGNAL', JSON.stringify(data));
        const encryptedSend = await this.mewCrypto.encrypt(
          JSON.stringify(data)
        );
        this.uiCommunicator(this.lifeCycle.sendOffer);
        this.socketEmit(this.signals.offerSignal, {
          data: encryptedSend,
          connId: this.connId,
          options: options.servers
        });
      } catch (e) {
        logger.error(e);
      }
    };
  }

  // Handle the WebRTC ANSWER from the opposite (mobile) peer
  async recieveAnswer(data) {
    console.log('recieveAnswer', data); // todo remove dev item
    try {
      const plainTextOffer = await this.mewCrypto.decrypt(data.data);
      this.webRtcCommunication.recieveAnswer(JSON.parse(plainTextOffer));
      // this.rtcRecieveAnswer({ data: plainTextOffer });
    } catch (e) {
      logger.error(e);
    }
  }

  rtcRecieveAnswer(data) {
    this.uiCommunicator(this.lifeCycle.answerReceived);
    this.p.signal(JSON.parse(data.data));
  }

  async useFallback() {
    this.socketEmit(this.signals.tryTurn, { connId: this.connId });
  }

  // ----- WebRTC Communication Event Handlers

  onConnect(peerID) {
    debugStages('RTC CONNECT', 'ok');
    debugPeer('peerID', peerID);
    this.connected = true;
    this.turnDisabled = true;
    this.socketEmit(this.signals.rtcConnected, this.socketKey);
    this.socketDisconnect();
    this.uiCommunicator(this.lifeCycle.RtcConnectedEvent);
  }

  onData(data) {
    this.emit(data.type, data.data);
  }

}