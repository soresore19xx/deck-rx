import Foundation

/// What the receiver core needs from whatever is handing it IQ.
///
/// Two things answer it: `SpyClient`, which reads a SpyServer over TCP, and
/// `AirspyDevice`, which drives an Airspy HF+ on this machine's own USB.
///
/// The shape is the SpyServer client's — its `DeviceInfo`, its setting ids, its
/// int16 packets — rather than some neutral idea of a radio. That client came
/// first and the whole pipeline behind it is written against those types, so a
/// neutral protocol would mean rewriting working demodulators for the sake of
/// the newcomer. The newcomer translates instead: the device fills in the same
/// structures and answers the same settings, and nothing upstream of
/// `LocalRadio.openConnection` can tell which one is running.
protocol IQSource: AnyObject {
    var onDeviceInfo: ((SpyClient.DeviceInfo) -> Void)? { get set }
    var onIQ: ((SpyClient.IQPacket) -> Void)? { get set }
    var onSync: ((SpyClient.SyncInfo) -> Void)? { get set }
    var onDisconnect: (() -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }

    /// Host and port are the SpyServer's; a local device ignores both. Named
    /// `open` rather than `connect` because that is what one of the two does.
    func open(host: String, port: UInt16, completion: @escaping (Result<Void, Error>) -> Void)
    func setSetting(_ setting: SpyClient.Setting, _ value: UInt32)
    func setFrequency(_ hz: UInt32)
    func stopStreaming()
    func disconnect()
}

extension SpyClient: IQSource {
    /// The client's own `connect` carries a default timeout, which a protocol
    /// requirement cannot, so this hands it through.
    func open(host: String, port: UInt16, completion: @escaping (Result<Void, Error>) -> Void) {
        connect(host: host, port: port, completion: completion)
    }
}
