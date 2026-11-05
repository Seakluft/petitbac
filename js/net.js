window.PBNet = (function () {
  'use strict';

  const PREFIX = 'petitbac-v2-';
  // messages qui DOIVENT arriver : acquittement + retransmission automatique
  const CRITICAL = { hello: 1, answers: 1, 'votes-done': 1, stop: 1 };

  function hostId(code) { return PREFIX + 'host-' + code; }
  function guestSlug(name) {
    return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18) || 'joueur';
  }

  // ID déterministe : même code + même prénom = même identité (reconnexion possible)
  function guestId(code, name) {
    return PREFIX + 'guest-' + code + '-' + guestSlug(name);
  }

  function mid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

  function createHost(code, handlers) {
    const peer = new Peer(hostId(code));
    const conns = new Map();
    const api = {
      peer, code, isHost: true, conns,
      onOpen: handlers.onOpen, onError: handlers.onError,
      isConnected() { return !!peer.open; },
      pendingCount() { return 0; },
      sendTo(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
      broadcast(msg) { conns.forEach((c, id) => { if (c.open) c.send(Object.assign({ from: peer.id }, msg)); }); },
      close() { try { peer.destroy(); } catch (e) {} }
    };
    peer.on('open', id => { if (handlers.onOpen) handlers.onOpen(id); });
    peer.on('connection', conn => {
      conn.on('open', () => {
        conns.set(conn.peer, conn); // remplace l'ancienne connexion du même joueur (reconnexion)
        if (handlers.onGuestJoined) handlers.onGuestJoined(conn.peer, conn);
      });
      conn.on('data', data => {
        // acquittement générique : tout message portant un id est confirmé à l'envoyeur
        try { if (data && data.mid) conn.send({ type: 'msg-ack', mid: data.mid }); } catch (e) {}
        if (handlers.onData) handlers.onData(conn.peer, data);
      });
      conn.on('close', () => {
        // ne retire la connexion QUE si c'est toujours la courante :
        // la fermeture (tardive) d'une ancienne connexion ne doit pas tuer la nouvelle
        if (conns.get(conn.peer) === conn) conns.delete(conn.peer);
        if (handlers.onGuestLeft) handlers.onGuestLeft(conn.peer);
      });
      conn.on('error', () => {
        if (conns.get(conn.peer) === conn) conns.delete(conn.peer);
      });
    });
    peer.on('error', err => { if (handlers.onError) handlers.onError(err); });
    return api;
  }

  function joinAsGuest(code, name, handlers, opts) {
    opts = opts || {};
    const retryMs = opts.retryMs || 2000;              // retransmission d'un message critique
    const baseMs = opts.reconnectBaseMs != null ? opts.reconnectBaseMs : 800;
    const maxMs = opts.reconnectMaxMs != null ? opts.reconnectMaxMs : 4000;

    let peer = null;
    let conn = null;
    let everConnected = false;
    let destroyed = false;
    let reconnectAttempts = 0;
    let idRetries = 0;
    const outbox = []; // {msg, tries, critical, sent} — les critiques restent jusqu'à l'ack

    function rawSend(m) {
      if (conn && conn.open) { conn.send(Object.assign({ from: peer.id }, m)); return true; }
      return false;
    }

    // envoie tout ce qui peut partir, dans l'ordre ; la tête « critique » attend son ack
    function flush() {
      if (!conn || !conn.open) return;
      let guard = 0;
      while (outbox.length && guard++ < 300) {
        const item = outbox[0];
        if (item.critical && item.sent) break; // attend l'accusé de réception
        rawSend(item.msg);
        item.sent = true;
        item.tries = 1;
        if (handlers.onSent) handlers.onSent(item.msg, item.tries);
        if (item.critical) break;
        outbox.shift(); // message simple : parti = oublié
      }
    }

    // toutes les N ms : retransmet le message critique en tête tant qu'il n'est pas acquitté
    function pump() {
      if (destroyed || !outbox.length) return;
      const item = outbox[0];
      if (!item.critical) { outbox.shift(); return; }
      if (item.tries >= 6) {
        outbox.shift();
        if (handlers.onGiveUp) handlers.onGiveUp(item.msg);
        flush();
        return;
      }
      if (conn && conn.open) {
        rawSend(item.msg);
        item.tries++;
        if (handlers.onRetry) handlers.onRetry(item.msg, item.tries);
      }
    }
    const pumpTimer = setInterval(pump, retryMs);

    function onAck(id) {
      const i = outbox.findIndex(it => it.msg.mid === id);
      if (i >= 0) outbox.splice(i, 1);
      flush();
    }

    function wireDataChannel(c) {
      conn = c;
      c.on('open', () => {
        everConnected = true;
        reconnectAttempts = 0;
        if (handlers.onOpen) handlers.onOpen(peer.id, c);
        flush();
      });
      c.on('data', d => {
        if (d && d.type === 'msg-ack' && d.mid) onAck(d.mid);
        if (handlers.onData) handlers.onData(hostId(code), d);
      });
      c.on('close', () => {
        if (conn !== c) return; // une connexion plus récente a déjà pris le relais
        conn = null;
        if (handlers.onConnLost) handlers.onConnLost();
        scheduleReconnect();
      });
      c.on('error', () => { /* la fermeture éventuelle déclenchera la reconnexion */ });
    }

    function connectDataChannel() {
      if (destroyed || (conn && conn.open)) return;
      try { wireDataChannel(peer.connect(hostId(code), { reliable: true })); } catch (e) {}
    }

    function scheduleReconnect() {
      if (destroyed) return;
      reconnectAttempts++;
      const delay = Math.min(baseMs * reconnectAttempts, maxMs);
      setTimeout(() => {
        if (destroyed) return;
        if (peer.open) connectDataChannel();
        else { try { peer.reconnect(); } catch (e) {} }
      }, delay);
    }

    function wirePeer(p) {
      p.on('open', () => { connectDataChannel(); });
      p.on('disconnected', () => { if (!destroyed) { try { p.reconnect(); } catch (e) {} } });
      p.on('error', err => {
        const t = err && err.type;
        if (t === 'peer-unavailable') {
          if (everConnected) { if (handlers.onHostGone) handlers.onHostGone(); }
          else if (handlers.onHostMissing) handlers.onHostMissing();
          scheduleReconnect(); // on retente : l'hôte peut revenir
        } else if (t === 'unavailable-id' && !everConnected) {
          // l'ID est momentanément occupé (reconnexion rapide) : on retente quelques fois
          if (idRetries++ < 3) { setTimeout(() => { if (!destroyed) { try { p.reconnect(); } catch (e) {} } }, 1500); }
          else if (handlers.onError) handlers.onError(err);
        } else if (!everConnected) {
          if (handlers.onError) handlers.onError(err);
        }
        // après une première connexion réussie : erreurs transitoires ignorées,
        // la reconnexion automatique s'en charge
      });
    }

    peer = new Peer(guestId(code, name));
    wirePeer(peer);

    // au retour sur l'onglet (mobile : écran rallumé / app quittée) on tente tout de suite
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !destroyed && (!conn || !conn.open)) {
        reconnectAttempts = 0;
        if (peer && peer.open) connectDataChannel();
        else if (peer) { try { peer.reconnect(); } catch (e) {} }
      }
    });

    return {
      peer, code, name, isHost: false,
      onOpen: handlers.onOpen, onError: handlers.onError,
      isConnected() { return !!(conn && conn.open); },
      pendingCount() { return outbox.length; },
      send(msg) {
        // copie profonde : le message envoyé ne doit pas bouger si l'état du jeu change ensuite
        let m;
        try { m = JSON.parse(JSON.stringify(msg)); } catch (e) { m = Object.assign({}, msg); }
        if (CRITICAL[m.type] && !m.mid) m.mid = mid();
        const item = { msg: m, tries: 0, critical: !!CRITICAL[m.type], sent: false };
        outbox.push(item);
        flush();
        if (!item.sent && handlers.onQueued) handlers.onQueued(m);
      },
      close() { destroyed = true; clearInterval(pumpTimer); try { peer.destroy(); } catch (e) {} }
    };
  }

  return { createHost, joinAsGuest, hostId, guestId, guestSlug, PREFIX };
})();
