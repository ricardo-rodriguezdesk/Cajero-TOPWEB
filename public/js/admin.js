// Panel administrativo del cajero.
(() => {
  const $ = (id) => document.getElementById(id);
  const pesos = (n) =>
    Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  const fecha = (iso) =>
    new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const ETIQUETA_ESTADO = {
    aprobada: 'Aprobada',
    rechazada_cajero: 'Rechazada por el cajero',
    rechazada_central: 'Rechazada por el Central',
    error_comunicacion: 'Error de comunicación',
    pendiente: 'Pendiente',
  };
  const ETIQUETA_TIPO = { retiro: 'Retiro', deposito: 'Depósito', consulta: 'Consulta' };
  const ETIQUETA_EVENTO = {
    configuracion: 'Configuración',
    sincronizacion: 'Sincronización',
    conexion_fallida: 'Conexión fallida',
    fuera_de_servicio: 'Fuera de servicio',
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const error = new Error(data.error || `Error ${res.status}`);
      error.status = res.status;
      error.codigo = data.codigo;
      throw error;
    }
    return data;
  }

  function aviso(texto, tipo = 'ok') {
    const el = $('msg-panel');
    el.textContent = texto;
    el.className = `mensaje banner ${tipo}`;
    el.hidden = false;
  }

  function verLogin() {
    $('vista-panel').hidden = true;
    $('vista-login').hidden = false;
    $('password').focus();
  }

  // Crea un elemento con texto (evita insertar HTML que venga de la base de datos)
  function el(tag, props = {}, ...hijos) {
    const nodo = document.createElement(tag);
    Object.assign(nodo, props);
    nodo.append(...hijos.filter((h) => h !== null && h !== undefined));
    return nodo;
  }

  // ---------- Pintar ----------
  function pintar(cfg) {
    $('vista-login').hidden = true;
    $('vista-panel').hidden = false;

    const pastilla = $('pastilla-estado');
    pastilla.textContent = cfg.en_servicio ? 'En servicio' : 'Fuera de servicio';
    pastilla.className = `pastilla ${cfg.en_servicio ? 'ok' : 'error'}`;

    const nodo = cfg.nodo || {};
    $('titulo-nodo').textContent = nodo.nombre || 'Cajero sin configurar';
    $('k-efectivo').textContent = cfg.efectivo_local === null ? '—' : pesos(cfg.efectivo_local);
    $('k-sync').textContent = cfg.sincronizado_en ? `Sincronizado ${fecha(cfg.sincronizado_en)}` : 'Sin sincronizar';
    $('d-nodo').textContent = nodo.id ? `#${nodo.id}` : '—';
    $('d-responsable').textContent = nodo.responsable || '—';
    $('d-estado').textContent = nodo.estado || '—';
    $('d-key').textContent = cfg.api_key || 'Sin configurar';
    $('d-url').textContent = cfg.modo === 'simulador' ? 'Simulador local' : cfg.central_url || 'Sin configurar';
    $('d-modo').textContent = cfg.modo === 'simulador' ? 'Simulador (USE_MOCK=true)' : 'API real';
    $('d-bd').textContent = cfg.base_de_datos === 'conectada' ? 'Conectada' : '—';

    if (cfg.central_url && !$('central-url').value) $('central-url').value = cfg.central_url;
  }

  function pintarResumen(r) {
    $('k-retiros').textContent = pesos(r.monto_retiros);
    $('k-retiros-n').textContent = `${r.retiros} aprobados`;
    $('k-depositos').textContent = pesos(r.monto_depositos);
    $('k-depositos-n').textContent = `${r.depositos} aprobados · ${r.consultas} consultas`;
    const total = r.rechazadas_cajero + r.rechazadas_central + r.errores_comunicacion;
    $('k-rechazos').textContent = String(total);
    $('k-rechazos-d').textContent =
      `${r.rechazadas_cajero} cajero · ${r.rechazadas_central} Central · ${r.errores_comunicacion} comunicación`;
  }

  function pintarOperaciones(lista) {
    const cuerpo = $('t-operaciones');
    cuerpo.replaceChildren();
    if (!lista.length) {
      cuerpo.append(el('tr', {}, el('td', { colSpan: 8, className: 'vacio', textContent: 'Sin operaciones' })));
      return;
    }
    for (const op of lista) {
      const resultado = el('td', {},
        el('span', { className: `estado ${op.estado}`, textContent: ETIQUETA_ESTADO[op.estado] || op.estado }),
        op.codigo ? el('span', { className: 'codigo', textContent: op.codigo, title: op.mensaje || '' }) : null
      );
      cuerpo.append(el('tr', {},
        el('td', { className: 'num', textContent: op.id }),
        el('td', { textContent: fecha(op.fecha) }),
        el('td', { textContent: ETIQUETA_TIPO[op.tipo] || op.tipo }),
        el('td', { className: 'mono', textContent: op.cuenta }),
        el('td', { className: 'num', textContent: op.monto === null ? '—' : pesos(op.monto) }),
        resultado,
        el('td', { className: 'num', textContent: op.folio_central ?? '—' }),
        el('td', { className: 'num', textContent: op.efectivo_despues === null ? '—' : pesos(op.efectivo_despues) })
      ));
    }
  }

  function describirEvento(e) {
    const d = e.detalle || {};
    switch (e.tipo) {
      case 'sincronizacion': {
        const base = `${d.motivo || 'Sincronización'}: el Central reporta ${pesos(d.efectivo_central)}`;
        if (d.diferencia === null || d.diferencia === undefined) return base;
        if (d.diferencia === 0) return `${base}. Cuadre correcto.`;
        return `${base}; el cajero tenía ${pesos(d.efectivo_local)} (diferencia ${pesos(d.diferencia)}).`;
      }
      case 'configuracion':
        return [d.api_key_cambiada && `API Key nueva (termina en ${d.api_key_final})`, d.url_cambiada && 'URL del Central actualizada']
          .filter(Boolean).join(' · ') || 'Configuración guardada';
      case 'conexion_fallida':
        return `${d.error || 'No se pudo conectar'}${d.codigo ? ` (${d.codigo})` : ''}`;
      case 'fuera_de_servicio':
        return d.motivo || 'Cajero puesto fuera de servicio';
      default:
        return JSON.stringify(d);
    }
  }

  function pintarEventos(lista) {
    const ul = $('l-eventos');
    ul.replaceChildren();
    if (!lista.length) {
      ul.append(el('li', { className: 'vacio', textContent: 'Sin eventos' }));
      return;
    }
    for (const e of lista) {
      ul.append(el('li', {},
        el('time', { dateTime: e.fecha, textContent: fecha(e.fecha) }),
        el('span', {}, el('strong', { textContent: `${ETIQUETA_EVENTO[e.tipo] || e.tipo}. ` }), describirEvento(e))
      ));
    }
  }

  // ---------- Cargar ----------
  async function cargarBitacora() {
    const params = new URLSearchParams({ limite: '50' });
    if ($('f-tipo').value) params.set('tipo', $('f-tipo').value);
    if ($('f-estado').value) params.set('estado', $('f-estado').value);
    const [resumen, ops, eventos] = await Promise.all([
      api('GET', '/admin/api/resumen'),
      api('GET', `/admin/api/operaciones?${params}`),
      api('GET', '/admin/api/eventos'),
    ]);
    pintarResumen(resumen);
    pintarOperaciones(ops);
    pintarEventos(eventos);
  }

  async function cargar() {
    try {
      pintar(await api('GET', '/admin/api/config'));
      await cargarBitacora();
    } catch (error) {
      if (error.status === 401) return verLogin();
      if ($('vista-panel').hidden) {
        verLogin();
        $('msg-login').textContent = error.message;
        $('msg-login').className = 'mensaje error';
      } else {
        aviso(error.message, 'error');
      }
    }
  }

  async function conBoton(boton, tarea) {
    boton.disabled = true;
    try {
      await tarea();
    } catch (error) {
      if (error.status === 401 && error.codigo === 'SESION_INVALIDA') return verLogin();
      aviso(error.message + (error.codigo ? ` (${error.codigo})` : ''), 'error');
    } finally {
      boton.disabled = false;
      cargarBitacora().catch(() => {});
    }
  }

  // ---------- Eventos de la página ----------
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('msg-login');
    msg.textContent = '';
    try {
      await api('POST', '/admin/api/login', { password: $('password').value });
      $('password').value = '';
      await cargar();
    } catch (error) {
      msg.textContent = error.message;
      msg.className = 'mensaje error';
    }
  });

  $('btn-salir').addEventListener('click', async () => {
    await api('POST', '/admin/api/logout').catch(() => {});
    verLogin();
  });

  $('form-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const boton = e.submitter || e.target.querySelector('button');
    conBoton(boton, async () => {
      const body = {};
      const url = $('central-url').value.trim();
      const key = $('api-key').value.trim();
      if (url) body.central_url = url;
      if (key) body.api_key = key;
      const r = await api('PUT', '/admin/api/config', body);
      $('api-key').value = '';
      pintar(r);
      if (r.conexion.ok) {
        aviso(`Conectado como "${r.conexion.nodo.nombre}". Efectivo sincronizado: ${pesos(r.conexion.nodo.efectivo_disponible)}.`);
      } else {
        aviso(`Configuración guardada, pero no se pudo conectar: ${r.conexion.error}`, 'error');
      }
    });
  });

  $('btn-probar').addEventListener('click', (e) =>
    conBoton(e.currentTarget, async () => {
      const r = await api('POST', '/admin/api/test');
      aviso(`Conexión correcta. El Banco Central reconoce este cajero como "${r.nodo.nombre}" (${r.nodo.estado}).`);
    })
  );

  $('btn-sync').addEventListener('click', (e) =>
    conBoton(e.currentTarget, async () => {
      const r = await api('POST', '/admin/api/sync');
      pintar(r);
      const { efectivo_local: local, efectivo_central: oficial, diferencia } = r.cuadre;
      if (diferencia === null) aviso(`Efectivo sincronizado con el Banco Central: ${pesos(oficial)}.`);
      else if (diferencia === 0) aviso(`Cuadre correcto: el cajero y el Banco Central coinciden en ${pesos(oficial)}.`);
      else aviso(`Diferencia de ${pesos(diferencia)}: el cajero tenía ${pesos(local)} y el Central reporta ${pesos(oficial)}. Se tomó el valor del Central.`, 'error');
    })
  );

  $('btn-reset').addEventListener('click', (e) => {
    if (!confirm('¿Poner este cajero fuera de servicio? Se borrará su API Key.')) return;
    conBoton(e.currentTarget, async () => {
      pintar(await api('DELETE', '/admin/api/config'));
      aviso('El cajero quedó fuera de servicio.', 'error');
    });
  });

  $('btn-refrescar').addEventListener('click', (e) => conBoton(e.currentTarget, cargarBitacora));
  $('f-tipo').addEventListener('change', () => cargarBitacora().catch((e) => aviso(e.message, 'error')));
  $('f-estado').addEventListener('change', () => cargarBitacora().catch((e) => aviso(e.message, 'error')));

  cargar();
})();
