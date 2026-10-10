// Interfaz del cliente del cajero. Solo habla con el backend del propio cajero (/api/...).
(() => {
  const $ = (id) => document.getElementById(id);
  const pesos = (n) =>
    Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

  const estado = {
    vista: 'cargando',
    cuenta: '',
    titular: '',
    tipo: null, // 'retiro' | 'deposito'
    entradaCuenta: '',
    entradaMonto: '',
    ocupado: false,
  };

  function mostrar(vista) {
    estado.vista = vista;
    document.querySelectorAll('.vista').forEach((v) => v.classList.toggle('activa', v.dataset.vista === vista));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const error = new Error(data.error || 'Error de comunicación');
      error.codigo = data.codigo;
      error.origen = data.origen;
      throw error;
    }
    return data;
  }

  // ---------- Arranque ----------
  async function iniciar() {
    mostrar('cargando');
    try {
      const st = await api('GET', '/api/status');
      if (st.nombre) $('nombre-cajero').textContent = st.nombre;
      $('modo').textContent = st.modo === 'simulador' ? 'Simulador' : '';
      if (!st.en_servicio) return mostrar('fuera');
      reiniciarSesion();
    } catch {
      mostrar('fuera');
    }
  }

  function reiniciarSesion() {
    Object.assign(estado, { cuenta: '', titular: '', tipo: null, entradaCuenta: '', entradaMonto: '' });
    pintarDisplays();
    mostrar('inicio');
  }

  function pintarDisplays() {
    $('display-cuenta').textContent = estado.entradaCuenta;
    $('display-monto').textContent = estado.entradaMonto ? '$' + Number(estado.entradaMonto).toLocaleString('es-MX') : '';
  }

  // ---------- Pantallas de resultado ----------
  function resultadoOk({ titulo, cifra, texto, detalle }) {
    const vista = document.querySelector('[data-vista="resultado"]');
    vista.classList.remove('falla');
    vista.classList.add('ok');
    $('res-icono').textContent = '✓';
    $('res-titulo').textContent = titulo;
    $('res-cifra').textContent = cifra || '';
    $('res-texto').textContent = texto || '';
    $('res-origen').hidden = true;
    $('res-detalle').textContent = detalle || '';
    mostrar('resultado');
  }

  function resultadoError(error) {
    // Si el cajero quedó fuera de servicio, se va directo a esa pantalla.
    const FUERA_DE_SERVICIO = [
      'CAJERO_NO_CONFIGURADO', 'CAJERO_NO_SINCRONIZADO', 'API_KEY_INVALIDA', 'NODO_INACTIVO',
      'API_KEY_ILEGIBLE', 'BD_NO_CONFIGURADA', 'BD_NO_DISPONIBLE', 'SECRETO_NO_CONFIGURADO',
    ];
    if (FUERA_DE_SERVICIO.includes(error.codigo)) {
      return mostrar('fuera');
    }
    const vista = document.querySelector('[data-vista="resultado"]');
    vista.classList.remove('ok');
    vista.classList.add('falla');
    $('res-icono').textContent = '✕';
    $('res-titulo').textContent = 'Operación no realizada';
    $('res-cifra').textContent = '';
    $('res-texto').textContent = error.message;
    const origen = $('res-origen');
    origen.hidden = !error.origen;
    origen.textContent = error.origen === 'central' ? 'Rechazado por el Banco Central' : 'Rechazado por el cajero';
    $('res-detalle').textContent = error.codigo ? `Código: ${error.codigo}` : '';
    mostrar('resultado');
  }

  // ---------- Operaciones ----------
  async function validarCuenta() {
    const numero = estado.entradaCuenta;
    if (!numero) return;
    mostrar('procesando');
    try {
      const cuenta = await api('GET', `/api/balance/${encodeURIComponent(numero)}`);
      estado.cuenta = cuenta.numero_cuenta;
      estado.titular = cuenta.titular;
      $('saludo').textContent = `Hola, ${cuenta.titular.split(' ')[0]}`;
      $('cuenta-menu').textContent = '••••' + cuenta.numero_cuenta.slice(-4);
      mostrar('menu');
    } catch (error) {
      if (error.codigo === 'CUENTA_NO_ENCONTRADA' || error.codigo === 'DATOS_INVALIDOS') {
        estado.entradaCuenta = '';
        pintarDisplays();
      }
      // Sin cuenta válida, "Otra operación" regresa al inicio (ver irAlMenu).
      resultadoError(error);
    }
  }

  async function consultarSaldo() {
    mostrar('procesando');
    try {
      const cuenta = await api('GET', `/api/balance/${encodeURIComponent(estado.cuenta)}`);
      resultadoOk({
        titulo: 'Saldo disponible',
        cifra: pesos(cuenta.saldo),
        texto: `${cuenta.titular} · cuenta ${cuenta.estado}`,
      });
    } catch (error) {
      resultadoError(error);
    }
  }

  async function operar(monto) {
    if (estado.ocupado) return;
    estado.ocupado = true;
    mostrar('procesando');
    try {
      const ruta = estado.tipo === 'retiro' ? '/api/withdraw' : '/api/deposit';
      const r = await api('POST', ruta, { numero_cuenta: estado.cuenta, monto });
      resultadoOk({
        titulo: estado.tipo === 'retiro' ? 'Retire su efectivo' : 'Depósito recibido',
        cifra: pesos(r.monto),
        texto: `Saldo actual: ${pesos(r.saldo_nuevo)}`,
        detalle: `Folio ${r.transaccion.id} · ${new Date(r.transaccion.fecha).toLocaleString('es-MX')}`,
      });
    } catch (error) {
      resultadoError(error);
    } finally {
      estado.ocupado = false;
    }
  }

  function elegirTipo(tipo) {
    estado.tipo = tipo;
    $('titulo-monto').textContent = tipo === 'retiro' ? 'Retirar efectivo' : 'Depositar';
    $('titulo-otra').textContent = tipo === 'retiro' ? 'Otra cantidad a retirar' : 'Cantidad a depositar';
    mostrar('monto');
  }

  function irAlMenu() {
    if (!estado.cuenta) return reiniciarSesion();
    estado.entradaMonto = '';
    pintarDisplays();
    mostrar('menu');
  }

  // ---------- Botones de pantalla ----------
  document.querySelector('.pantalla').addEventListener('click', (e) => {
    const boton = e.target.closest('button');
    if (!boton) return;
    const { accion, monto } = boton.dataset;
    if (monto) return operar(Number(monto));
    switch (accion) {
      case 'saldo': return consultarSaldo();
      case 'retiro': return elegirTipo('retiro');
      case 'deposito': return elegirTipo('deposito');
      case 'otra':
        estado.entradaMonto = '';
        pintarDisplays();
        return mostrar('otra');
      case 'menu': return irAlMenu();
      case 'terminar': return reiniciarSesion();
      case 'reintentar': return iniciar();
    }
  });

  // ---------- Teclado ----------
  function tecla(valor) {
    const enCuenta = estado.vista === 'inicio';
    const enMonto = estado.vista === 'otra';

    if (/^\d$/.test(valor)) {
      if (enCuenta && estado.entradaCuenta.length < 20) estado.entradaCuenta += valor;
      if (enMonto && estado.entradaMonto.length < 6 && !(estado.entradaMonto === '' && valor === '0')) {
        estado.entradaMonto += valor;
      }
      return pintarDisplays();
    }

    if (valor === 'borrar') {
      if (enCuenta) estado.entradaCuenta = estado.entradaCuenta.slice(0, -1);
      if (enMonto) estado.entradaMonto = estado.entradaMonto.slice(0, -1);
      return pintarDisplays();
    }

    if (valor === 'continuar') {
      if (enCuenta) return validarCuenta();
      if (enMonto && estado.entradaMonto) return operar(Number(estado.entradaMonto));
      return;
    }

    if (valor === 'cancelar') {
      if (enMonto) return mostrar('monto');
      if (['menu', 'monto', 'resultado'].includes(estado.vista)) return reiniciarSesion();
      if (enCuenta) {
        estado.entradaCuenta = '';
        return pintarDisplays();
      }
    }
  }

  document.querySelector('.teclado').addEventListener('click', (e) => {
    const boton = e.target.closest('[data-tecla]');
    if (boton) tecla(boton.dataset.tecla);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (/^\d$/.test(e.key)) tecla(e.key);
    else if (e.key === 'Backspace') tecla('borrar');
    else if (e.key === 'Enter') { e.preventDefault(); tecla('continuar'); }
    else if (e.key === 'Escape') tecla('cancelar');
  });

  iniciar();
})();
