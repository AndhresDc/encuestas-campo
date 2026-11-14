// Panel público. Primero el ingreso del encuestador: solo escribe su nombre. Se guarda en este dispositivo,
// llena solo los campos marcados con "perfil" y el panel lo saluda. No hay cédula, código ni registro previo.
// Todo el texto entra por textContent.
(function () {
  'use strict';

  var datos = PANEL;
  var raiz = document.getElementById('app');
  document.documentElement.style.setProperty('--primario', '#1b5e20');
  document.documentElement.style.setProperty('--acento', '#f2b705');

  var TIEMPO_LIMITE_MS = 30000;
  var NOMBRE_MIN = 3;
  var NOMBRE_MAX = 120;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) agregar(el, arguments[i]);
    return el;
  }
  function agregar(el, hijo) {
    if (hijo === undefined || hijo === null || hijo === false) return;
    if (Array.isArray(hijo)) { hijo.forEach(function (x) { agregar(el, x); }); return; }
    el.appendChild(typeof hijo === 'string' ? document.createTextNode(hijo) : hijo);
  }

  // Mismo almacén que las encuestas (base "encuestas", tabla "kv"): así el perfil lo ven todas.
  var memoria = {};
  var conexion = null;
  function abrir() {
    if (conexion) return conexion;
    conexion = new Promise(function (ok, mal) {
      var r = indexedDB.open('encuestas', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { mal(r.error); };
    });
    return conexion;
  }
  function operar(modo, fn) {
    return abrir().then(function (db) {
      return new Promise(function (ok, mal) {
        var tx = db.transaction('kv', modo);
        var req = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { ok(req && req.result); };
        tx.onerror = function () { mal(tx.error); };
        tx.onabort = function () { mal(tx.error); };
      });
    });
  }
  function leer(k) { return operar('readonly', function (s) { return s.get(k); }).catch(function () { return memoria[k]; }); }
  function poner(k, v) { memoria[k] = v; return operar('readwrite', function (s) { return s.put(v, k); }).catch(function () {}); }
  function borrar(k) { delete memoria[k]; return operar('readwrite', function (s) { return s.delete(k); }).catch(function () {}); }

  // Dos transportes, igual que las encuestas: google.script.run en Apps Script y fetch en la versión instalable.
  function llamar(funcion, dato) {
    if (window.ENDPOINT) {
      var control = window.AbortController ? new AbortController() : null;
      var t = setTimeout(function () { if (control) control.abort(); }, TIEMPO_LIMITE_MS);
      return fetch(window.ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: funcion, dato: dato }), redirect: 'follow', credentials: 'omit',
        signal: control ? control.signal : undefined
      }).then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('http'); return r.json(); },
        function (e) { clearTimeout(t); throw e; });
    }
    return new Promise(function (ok, mal) {
      var listo = false;
      var t = setTimeout(function () { if (!listo) { listo = true; mal(new Error('tiempo')); } }, TIEMPO_LIMITE_MS);
      var fin = function (fn) { return function (x) { if (listo) return; listo = true; clearTimeout(t); fn(x); }; };
      google.script.run.withSuccessHandler(fin(ok)).withFailureHandler(fin(mal))[funcion](dato);
    });
  }

  function limpiarNombre(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
  function nombreValido(v) {
    return v.length >= NOMBRE_MIN && v.length <= NOMBRE_MAX && /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'\-]*$/.test(v);
  }
  function perfilCompleto(p) {
    return !!p && typeof p.nombre === 'string' && nombreValido(p.nombre);
  }

  function tarjeta(e, i) {
    return h('li', null,
      h('a', { class: 'tarjeta', href: e.enlace, style: 'border-left-color:' + (/^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : '#1b5e20') },
        h('span', { class: 'tarjeta-titulo' }, (i + 1) + '. ' + e.titulo),
        e.subtitulo ? h('span', { class: 'tarjeta-sub' }, e.subtitulo) : null,
        e.codigo ? h('span', { class: 'etiqueta-chip' }, 'Requiere código de acceso') : null));
  }

  function formularioIngreso(previo, alEntrar) {
    var entrada = h('input', {
      id: 'perfil-nombre', class: 'entrada', type: 'text', maxlength: NOMBRE_MAX, autocomplete: 'name',
      autocapitalize: 'words', spellcheck: 'false', value: (previo && previo.nombre) || ''
    });
    var mensaje = h('p', { class: 'estado estado-error oculto', role: 'alert' });
    return h('form', {
      novalidate: true,
      onsubmit: function (ev) {
        ev.preventDefault();
        var nombre = limpiarNombre(entrada.value);
        if (!nombreValido(nombre)) {
          mensaje.textContent = 'Escribe tu nombre (mínimo 3 letras, sin números).';
          mensaje.classList.remove('oculto');
          return;
        }
        mensaje.classList.add('oculto');
        var perfil = { nombre: nombre };
        poner('perfil', perfil).then(function () { alEntrar(perfil); });
      }
    },
      h('div', { class: 'pregunta' },
        h('label', { class: 'etiqueta', for: 'perfil-nombre' }, 'Nombre del encuestador *'),
        entrada, mensaje),
      h('button', { type: 'submit', class: 'boton boton-principal boton-ancho' }, 'Ingresar'));
  }

  function cabecera() {
    return h('header', { class: 'cabecera' }, h('div', { class: 'cabecera-interior' },
      h('div', { class: 'cabecera-titulos' },
        /^data:image\/(webp|png);base64,[A-Za-z0-9+\/=]+$/.test(datos.logoUrl || '')
          ? h('img', { class: 'logo', src: datos.logoUrl, alt: 'Consorcio Zaragoza 2026', width: '420', height: '234' }) : null,
        h('div', { class: 'cabecera-texto' },
          h('p', { class: 'encuesta-nombre' }, 'Consorcio Zaragoza 2026'),
          h('h1', { class: 'paso-titulo', tabindex: '-1' }, datos.titulo)))));
  }

  // Primera pantalla: el nombre, sin más trámite.
  function pintarIngreso(previo) {
    raiz.textContent = '';
    agregar(raiz, [cabecera(),
      h('main', { class: 'contenido panel' },
        h('h2', { class: 'panel-subtitulo' }, 'Ingreso del encuestador'),
        h('p', { class: 'ayuda' }, 'Escribe tu nombre. Se guarda en este dispositivo y llena solo las preguntas del encuestador en cada encuesta.'),
        formularioIngreso(previo, function (p) { pintar(p); }))]);
  }

  function pintar(perfil) {
    if (!perfilCompleto(perfil)) { pintarIngreso(perfil || {}); return; }
    raiz.textContent = '';
    agregar(raiz, [cabecera(),
      h('main', { class: 'contenido panel' },
        h('div', { class: 'mis-datos' },
          h('h2', { class: 'panel-subtitulo', role: 'status' }, '¡Bienvenido(a), ' + perfil.nombre + '!'),
          h('button', {
            type: 'button', class: 'boton-texto',
            onclick: function () { borrar('perfil').then(function () { pintarIngreso({}); }); }
          }, 'No soy yo / Cambiar de encuestador')),
        h('h2', { class: 'panel-subtitulo' }, 'Elige la encuesta que vas a realizar'),
        datos.encuestas.length
          ? h('ul', { class: 'tarjetas' }, datos.encuestas.map(tarjeta))
          : h('p', null, 'Por ahora no hay encuestas disponibles.'))]);
  }

  // Los celulares que ya guardaron cédula, código, teléfono o correo los pierden: ya no se piden ni se usan.
  leer('perfil').then(function (p) {
    p = p || {};
    var viejos = ['identificacion', 'codigo', 'telefono', 'correo'].filter(function (k) { return p[k] !== undefined; });
    if (viejos.length) {
      viejos.forEach(function (k) { delete p[k]; });
      if (p.nombre) poner('perfil', p); else borrar('perfil');
    }
    pintar(p);
  }, function () { pintar({}); });
})();
