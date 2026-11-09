/**
 * The Bluetooth LE sidecar of the local helper on Windows, in C# 5 (the .NET Framework 4 csc.exe
 * of every Windows 10/11 builds it, `build.ts`): WinRT advertisement watcher and GATT client, one
 * JSON message per line on stdin (`SidecarIn`) and stdout (`SidecarOut`). Kept as a string so the
 * helper's single-file build carries it; no backticks or dollar-brace in it.
 */
export const SIDECAR_SOURCE = String.raw`// Jumperly's Bluetooth LE sidecar for the local helper (Windows, WinRT): one JSON message per
// line on stdin (commands) and stdout (events). Built by the helper with the system csc.exe.
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Radios;
using Windows.Foundation;
using Windows.Storage.Streams;

public static class Program {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly object OutLock = new object();
  static BluetoothLEAdvertisementWatcher watcher;
  // Kept here: a local would be collected, and its StateChanged would stop.
  static BluetoothAdapter adapter;
  static Radio radio;
  static readonly Dictionary<int, Conn> conns = new Dictionary<int, Conn>();
  static int nextConn = 1;
  // Connections listening to each characteristic of a device (address:handle): the device has one
  // CCCD, written on the first and after the last of them.
  static readonly Dictionary<string, int> listening = new Dictionary<string, int>();

  static string Key(Conn c, GattCharacteristic ch) {
    return c.Device.BluetoothAddress.ToString("x12") + ":" + ch.AttributeHandle;
  }

  // The count of listeners after adding delta.
  static int Listen(string key, int delta) {
    lock (listening) {
      int n;
      listening.TryGetValue(key, out n);
      n = Math.Max(0, n + delta);
      if (n == 0) listening.Remove(key); else listening[key] = n;
      return n;
    }
  }
  // A board's table published for a phone (GattServiceProvider), and the phone's requests that
  // wait for the board's answer (their deferrals), all under ServeLock.
  static readonly object ServeLock = new object();
  static readonly Dictionary<int, Served> serves = new Dictionary<int, Served>();
  static readonly Dictionary<int, Pending> pendings = new Dictionary<int, Pending>();
  static int nextReq = 1;

  class Served {
    public readonly List<GattServiceProvider> Providers = new List<GattServiceProvider>();
    public readonly Dictionary<int, GattLocalCharacteristic> Chars = new Dictionary<int, GattLocalCharacteristic>();
    public bool Started;
  }

  class Pending {
    public int Serve;
    public Deferral Deferral;
    public GattReadRequest Read;
    public GattWriteRequest Write;
  }

  class Conn {
    public BluetoothLEDevice Device;
    public GattSession Session;
    public readonly Dictionary<int, object> Refs = new Dictionary<int, object>();
    public readonly Dictionary<int, TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs>> Handlers =
      new Dictionary<int, TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs>>();
    public readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);
  }

  static Dictionary<string, object> M(params object[] kv) {
    var d = new Dictionary<string, object>();
    for (int i = 0; i + 1 < kv.Length; i += 2) if (kv[i + 1] != null) d[(string)kv[i]] = kv[i + 1];
    return d;
  }

  static void Send(Dictionary<string, object> msg) {
    var line = Json.Serialize(msg);
    lock (OutLock) { Console.Out.Write(line); Console.Out.Write('\n'); Console.Out.Flush(); }
  }

  static Task<T> Await<T>(IAsyncOperation<T> op) {
    var tcs = new TaskCompletionSource<T>();
    op.Completed = (o, status) => {
      if (status == AsyncStatus.Completed) tcs.TrySetResult(o.GetResults());
      else if (status == AsyncStatus.Error) tcs.TrySetException(o.ErrorCode);
      else tcs.TrySetCanceled();
    };
    return tcs.Task;
  }

  static byte[] Bytes(IBuffer buf) {
    var b = new byte[buf.Length];
    DataReader.FromBuffer(buf).ReadBytes(b);
    return b;
  }

  static IBuffer Buffer(byte[] b) {
    var w = new DataWriter();
    w.WriteBytes(b);
    return w.DetachBuffer();
  }

  static void Log(string text) { Send(M("ev", "log", "text", text)); }

  static string Hex(byte[] b) {
    var s = new StringBuilder(b.Length * 2);
    foreach (var x in b) s.Append(x.ToString("x2"));
    return s.ToString();
  }

  static byte[] Unhex(string h) {
    var b = new byte[h.Length / 2];
    for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(h.Substring(2 * i, 2), 16);
    return b;
  }

  static string Addr(ulong a) {
    var s = a.ToString("x12");
    var p = new List<string>();
    for (int i = 0; i < 12; i += 2) p.Add(s.Substring(i, 2));
    return string.Join(":", p);
  }

  static ulong ParseAddr(string s) { return Convert.ToUInt64(s.Replace(":", ""), 16); }

  static string Status(GattCommunicationStatus st, byte? protocolError) {
    if (st == GattCommunicationStatus.Unreachable) return "unreachable";
    if (st == GattCommunicationStatus.AccessDenied) return "accessDenied";
    if (st == GattCommunicationStatus.ProtocolError)
      return "protocolError:" + (protocolError.HasValue ? protocolError.Value : 0);
    return st.ToString();
  }

  public static int Main() {
    Console.InputEncoding = new UTF8Encoding(false);
    Console.OutputEncoding = new UTF8Encoding(false);
    if (!WatchRadio().Wait(10000)) {
      Log("radio: no answer in 10 s");
      Send(M("ev", "radio", "state", "none"));
    }
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      try { Handle(Json.Deserialize<Dictionary<string, object>>(line)); }
      catch (Exception e) { Log("command failed: " + e.Message); }
    }
    if (watcher != null) watcher.Stop();
    lock (conns) foreach (var c in conns.Values) c.Device.Dispose();
    List<int> ids;
    lock (ServeLock) ids = new List<int>(serves.Keys);
    foreach (var id in ids) Unserve(id, null);
    return 0;
  }

  static async Task WatchRadio() {
    try {
      adapter = await Await(BluetoothAdapter.GetDefaultAsync());
      if (adapter == null || !adapter.IsLowEnergySupported) { Send(M("ev", "radio", "state", "none")); return; }
      radio = await Await(adapter.GetRadioAsync());
      bool peripheral = adapter.IsPeripheralRoleSupported;
      Send(M("ev", "radio", "state", radio.State == RadioState.On ? "on" : "off", "peripheral", peripheral));
      radio.StateChanged += (r, o) =>
        Send(M("ev", "radio", "state", r.State == RadioState.On ? "on" : "off", "peripheral", peripheral));
    } catch (Exception e) {
      Log("radio: " + e.Message);
      Send(M("ev", "radio", "state", "none"));
    }
  }

  static int I(Dictionary<string, object> m, string k) { return Convert.ToInt32(m[k]); }

  static void Handle(Dictionary<string, object> m) {
    var op = (string)m["op"];
    switch (op) {
      case "scan": Scan((bool)m["on"]); break;
      case "connect": {
        int id = I(m, "id");
        var addr = (string)m["addr"];
        bool random = (bool)m["random"];
        Task.Run(() => Connect(id, addr, random));
        break;
      }
      case "read": case "write": case "writeNoResponse": case "notify": {
        int id = I(m, "id"), conn = I(m, "conn"), r = I(m, "ref");
        string value = m.ContainsKey("value") ? (string)m["value"] : null;
        bool on = m.ContainsKey("on") && (bool)m["on"];
        Task.Run(() => Op(op, id, conn, r, value, on));
        break;
      }
      case "disconnect": Drop(I(m, "conn"), false); break;
      case "serve": {
        int id = I(m, "id");
        var services = (System.Collections.ArrayList)m["services"];
        Task.Run(() => Serve(id, services));
        break;
      }
      case "unserve": Unserve(I(m, "id"), "the board stopped"); break;
      case "reply":
        Reply(I(m, "req"), m.ContainsKey("value") ? (string)m["value"] : null,
          m.ContainsKey("error") ? (string)m["error"] : null);
        break;
      case "serveNotify": ServeNotify(I(m, "id"), I(m, "ref"), (string)m["value"]); break;
      default: Log("unknown op " + op); break;
    }
  }

  static void Scan(bool on) {
    if (on) {
      // A radio switched off aborts the watcher: a new one scans again.
      if (watcher != null && (watcher.Status == BluetoothLEAdvertisementWatcherStatus.Aborted ||
          watcher.Status == BluetoothLEAdvertisementWatcherStatus.Stopping)) watcher = null;
      if (watcher == null) {
        watcher = new BluetoothLEAdvertisementWatcher();
        watcher.ScanningMode = BluetoothLEScanningMode.Active;
        watcher.Received += (w, a) => {
          var data = new List<byte>();
          foreach (var d in a.Advertisement.DataSections) {
            var b = Bytes(d.Data);
            if (data.Count + b.Length + 2 > 31) break;
            data.Add((byte)(b.Length + 1));
            data.Add(d.DataType);
            data.AddRange(b);
          }
          var t = a.AdvertisementType;
          Send(M("ev", "adv", "addr", Addr(a.BluetoothAddress),
            "random", a.BluetoothAddressType == BluetoothAddressType.Random,
            "rssi", (int)a.RawSignalStrengthInDBm,
            "kind", t == BluetoothLEAdvertisementType.ScanResponse ? "rsp" : "adv",
            "connectable", t == BluetoothLEAdvertisementType.ConnectableUndirected || t == BluetoothLEAdvertisementType.ConnectableDirected,
            "data", Hex(data.ToArray())));
        };
        watcher.Stopped += (w, a) => { if (a.Error != BluetoothError.Success) Log("scan stopped: " + a.Error); };
      }
      if (watcher.Status != BluetoothLEAdvertisementWatcherStatus.Started) {
        try { watcher.Start(); } catch (Exception e) { Log("scan: " + e.Message); }
      }
    } else if (watcher != null) watcher.Stop();
  }

  static async Task Connect(int id, string addr, bool random) {
    BluetoothLEDevice dev = null;
    Conn conn = null;
    int cid = 0;
    try {
      dev = await Await(BluetoothLEDevice.FromBluetoothAddressAsync(ParseAddr(addr),
        random ? BluetoothAddressType.Random : BluetoothAddressType.Public));
      if (dev == null) { Send(M("ev", "failed", "id", id, "error", "unreachable")); return; }
      conn = new Conn { Device = dev };
      // Heard from the start: a drop once the connection is registered ends it.
      dev.ConnectionStatusChanged += (d, o) => {
        if (d.ConnectionStatus != BluetoothConnectionStatus.Disconnected) return;
        int c;
        lock (conns) c = cid;
        if (c != 0) Drop(c, true);
      };
      try {
        conn.Session = await Await(GattSession.FromDeviceIdAsync(dev.BluetoothDeviceId));
        conn.Session.MaintainConnection = true;
      } catch (Exception e) { Log("session: " + e.Message); }
      var sr = await Await(dev.GetGattServicesAsync(BluetoothCacheMode.Uncached));
      if (sr.Status != GattCommunicationStatus.Success) {
        if (conn.Session != null) conn.Session.Dispose();
        dev.Dispose();
        Send(M("ev", "failed", "id", id, "error", Status(sr.Status, sr.ProtocolError)));
        return;
      }
      var services = new List<object>();
      int r = 1;
      foreach (var s in sr.Services) {
        var chars = new List<object>();
        var cr = await Await(s.GetCharacteristicsAsync(BluetoothCacheMode.Uncached));
        if (cr.Status == GattCommunicationStatus.Success)
          foreach (var c in cr.Characteristics) {
            int cref = r++;
            conn.Refs[cref] = c;
            var descs = new List<object>();
            var dr = await Await(c.GetDescriptorsAsync(BluetoothCacheMode.Uncached));
            if (dr.Status == GattCommunicationStatus.Success)
              foreach (var d in dr.Descriptors) {
                conn.Refs[r] = d;
                descs.Add(M("uuid", d.Uuid.ToString(), "ref", r));
                r++;
              }
            chars.Add(M("uuid", c.Uuid.ToString(), "ref", cref,
              "properties", (int)c.CharacteristicProperties & 0x3e, "descriptors", descs));
          }
        services.Add(M("uuid", s.Uuid.ToString(), "characteristics", chars));
      }
      // Registered and announced under the lock a drop takes too: a drop during the discovery is
      // seen here, one after it comes as closed after opened.
      lock (conns) {
        if (dev.ConnectionStatus == BluetoothConnectionStatus.Disconnected)
          throw new Exception("unreachable");
        cid = nextConn++;
        conns[cid] = conn;
        Send(M("ev", "opened", "id", id, "conn", cid, "services", services));
      }
    } catch (Exception e) {
      if (cid == 0) {
        try {
          if (conn != null && conn.Session != null) conn.Session.Dispose();
          if (dev != null) dev.Dispose();
        } catch (Exception) { }
      }
      Send(M("ev", "failed", "id", id, "error", e.Message));
    }
  }

  static void Result(int id, string value, string error) {
    Send(M("ev", "result", "id", id, "value", value, "error", error));
  }

  static async Task Op(string op, int id, int connId, int refId, string value, bool on) {
    Conn c;
    lock (conns) conns.TryGetValue(connId, out c);
    object target = null;
    if (c != null) c.Refs.TryGetValue(refId, out target);
    if (target == null) { Result(id, null, "invalid"); return; }
    await c.Gate.WaitAsync();
    try {
      var ch = target as GattCharacteristic;
      var de = target as GattDescriptor;
      if (op == "read") {
        var rr = ch != null
          ? await Await(ch.ReadValueAsync(BluetoothCacheMode.Uncached))
          : await Await(de.ReadValueAsync(BluetoothCacheMode.Uncached));
        if (rr.Status == GattCommunicationStatus.Success) Result(id, Hex(Bytes(rr.Value)), null);
        else Result(id, null, Status(rr.Status, rr.ProtocolError));
      } else if (op == "write" || op == "writeNoResponse") {
        var buf = Buffer(Unhex(value ?? ""));
        var wr = ch != null
          ? await Await(ch.WriteValueWithResultAsync(buf,
              op == "write" ? GattWriteOption.WriteWithResponse : GattWriteOption.WriteWithoutResponse))
          : await Await(de.WriteValueWithResultAsync(buf));
        if (wr.Status == GattCommunicationStatus.Success) Result(id, null, null);
        else Result(id, null, Status(wr.Status, wr.ProtocolError));
      } else if (op == "notify") {
        if (ch == null) { Result(id, null, "invalid"); return; }
        TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs> h;
        var key = Key(c, ch);
        bool write;
        if (on) {
          if (c.Handlers.ContainsKey(refId)) { Result(id, null, null); return; }
          h = (s, a) => Send(M("ev", "notify", "conn", connId, "ref", refId,
            "value", Hex(Bytes(a.CharacteristicValue))));
          c.Handlers[refId] = h;
          ch.ValueChanged += h;
          write = Listen(key, 1) == 1;
        } else {
          if (!c.Handlers.TryGetValue(refId, out h)) { Result(id, null, null); return; }
          ch.ValueChanged -= h;
          c.Handlers.Remove(refId);
          write = Listen(key, -1) == 0;
        }
        if (!write) { Result(id, null, null); return; }
        var mode = !on ? GattClientCharacteristicConfigurationDescriptorValue.None
          : (ch.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0
            ? GattClientCharacteristicConfigurationDescriptorValue.Notify
            : GattClientCharacteristicConfigurationDescriptorValue.Indicate;
        var st = await Await(ch.WriteClientCharacteristicConfigurationDescriptorAsync(mode));
        if (st == GattCommunicationStatus.Success) Result(id, null, null);
        else Result(id, null, Status(st, null));
      }
    } catch (Exception e) {
      Result(id, null, e.Message);
    } finally {
      c.Gate.Release();
    }
  }

  // --- A board for a phone ---------------------------------------------------------------------

  static Guid UuidOf(string u) {
    if (u.Length == 4) u = "0000" + u + "-0000-1000-8000-00805f9b34fb";
    return new Guid(u);
  }

  static async Task Serve(int id, System.Collections.ArrayList services) {
    var served = new Served();
    lock (ServeLock) serves[id] = served;
    try {
      foreach (Dictionary<string, object> svc in services) {
        var uuid = (string)svc["uuid"];
        // Generic Access and Generic Attribute belong to Windows.
        if (uuid == "1800" || uuid == "1801" || uuid.StartsWith("00001800-") || uuid.StartsWith("00001801-")) continue;
        var pr = await Await(GattServiceProvider.CreateAsync(UuidOf(uuid)));
        if (pr.Error != BluetoothError.Success) throw new Exception("service " + uuid + ": " + pr.Error);
        var provider = pr.ServiceProvider;
        lock (ServeLock) served.Providers.Add(provider);
        foreach (Dictionary<string, object> ch in (System.Collections.ArrayList)svc["characteristics"]) {
          int r = I(ch, "ref");
          var props = (GattCharacteristicProperties)(Convert.ToInt32(ch["properties"]) & 0x3e);
          var p = new GattLocalCharacteristicParameters();
          p.CharacteristicProperties = props;
          p.ReadProtectionLevel = GattProtectionLevel.Plain;
          p.WriteProtectionLevel = GattProtectionLevel.Plain;
          var cr = await Await(provider.Service.CreateCharacteristicAsync(UuidOf((string)ch["uuid"]), p));
          if (cr.Error != BluetoothError.Success) throw new Exception("characteristic " + ch["uuid"] + ": " + cr.Error);
          var local = cr.Characteristic;
          lock (ServeLock) served.Chars[r] = local;
          local.ReadRequested += async (c, a) => {
            var d = a.GetDeferral();
            var req = await Await(a.GetRequestAsync());
            int q = Ask(id, d, req, null);
            Send(M("ev", "serveRead", "id", id, "req", q, "ref", r));
          };
          local.WriteRequested += async (c, a) => {
            var d = a.GetDeferral();
            var req = await Await(a.GetRequestAsync());
            var value = Hex(Bytes(req.Value));
            if (req.Option == GattWriteOption.WriteWithResponse) {
              int q = Ask(id, d, null, req);
              Send(M("ev", "serveWrite", "id", id, "req", q, "ref", r, "value", value, "response", true));
            } else {
              d.Complete();
              int q;
              lock (ServeLock) q = nextReq++;
              Send(M("ev", "serveWrite", "id", id, "req", q, "ref", r, "value", value, "response", false));
            }
          };
          local.SubscribedClientsChanged += (c, o) =>
            Send(M("ev", "serveSubscribe", "id", id, "ref", r, "on", c.SubscribedClients.Count > 0));
        }
        provider.AdvertisementStatusChanged += (sp, a) => {
          if (a.Status == GattServiceProviderAdvertisementStatus.Started) {
            bool first;
            lock (ServeLock) { first = !served.Started; served.Started = true; }
            if (first) Send(M("ev", "served", "id", id));
          } else if (a.Error != BluetoothError.Success) {
            bool started;
            lock (ServeLock) started = served.Started;
            Unserve(id, null);
            Send(M("ev", started ? "serveStopped" : "serveFailed", "id", id, "error", "advertising: " + a.Error));
          }
        };
        var ap = new GattServiceProviderAdvertisingParameters();
        ap.IsConnectable = true;
        ap.IsDiscoverable = true;
        provider.StartAdvertising(ap);
      }
      bool none;
      lock (ServeLock) none = served.Providers.Count == 0;
      if (none) { Unserve(id, null); Send(M("ev", "serveFailed", "id", id, "error", "the board has no services to publish")); }
    } catch (Exception e) {
      Unserve(id, null);
      Send(M("ev", "serveFailed", "id", id, "error", e.Message));
    }
  }

  static int Ask(int serve, Deferral d, GattReadRequest read, GattWriteRequest write) {
    lock (ServeLock) {
      int q = nextReq++;
      pendings[q] = new Pending { Serve = serve, Deferral = d, Read = read, Write = write };
      return q;
    }
  }

  static void Reply(int req, string value, string error) {
    Pending p;
    lock (ServeLock) {
      if (!pendings.TryGetValue(req, out p)) return;
      pendings.Remove(req);
    }
    try {
      byte code = 0x0e;
      if (error != null && error.StartsWith("att:")) code = Convert.ToByte(error.Substring(4));
      if (p.Read != null) {
        if (error != null) p.Read.RespondWithProtocolError(code);
        else p.Read.RespondWithValue(Buffer(Unhex(value ?? "")));
      } else if (p.Write != null) {
        if (error != null) p.Write.RespondWithProtocolError(code);
        else p.Write.Respond();
      }
    } catch (Exception e) { Log("reply: " + e.Message); }
    finally { p.Deferral.Complete(); }
  }

  static void ServeNotify(int id, int r, string value) {
    GattLocalCharacteristic c = null;
    lock (ServeLock) {
      Served s;
      if (serves.TryGetValue(id, out s)) s.Chars.TryGetValue(r, out c);
    }
    if (c == null) return;
    var buf = Buffer(Unhex(value));
    Task.Run(async () => {
      try { await Await(c.NotifyValueAsync(buf)); } catch (Exception e) { Log("notify: " + e.Message); }
    });
  }

  // Stop publishing id; its waiting requests fail.
  static void Unserve(int id, string why) {
    Served s;
    var waiting = new List<int>();
    lock (ServeLock) {
      if (!serves.TryGetValue(id, out s)) return;
      serves.Remove(id);
      foreach (var kv in pendings) if (kv.Value.Serve == id) waiting.Add(kv.Key);
    }
    foreach (var q in waiting) Reply(q, null, "gone");
    foreach (var pr in s.Providers) {
      try { pr.StopAdvertising(); } catch (Exception) { }
    }
  }

  static void Drop(int connId, bool tell) {
    Conn c;
    lock (conns) {
      if (!conns.TryGetValue(connId, out c)) return;
      conns.Remove(connId);
    }
    foreach (var kv in c.Handlers) {
      object t;
      var ch = c.Refs.TryGetValue(kv.Key, out t) ? t as GattCharacteristic : null;
      if (ch == null) continue;
      try { ch.ValueChanged -= kv.Value; } catch (Exception) { }
      // The last listener of the device's characteristic: its CCCD off (the device may be gone).
      if (Listen(Key(c, ch), -1) == 0 && !tell) {
        var off = ch;
        Task.Run(async () => {
          try { await Await(off.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.None)); }
          catch (Exception) { }
        });
      }
    }
    c.Handlers.Clear();
    try {
      if (c.Session != null) c.Session.Dispose();
      c.Device.Dispose();
    } catch (Exception) { }
    if (tell) Send(M("ev", "closed", "conn", connId));
  }
}
`;
