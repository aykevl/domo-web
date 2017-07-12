'use strict';

const UNITS = {
	'temperature': '°C',
	'humidity': '%',
};
const SENSOR_ORDER = [
	'temperature',
	'humidity',
];
const CONN_NONE = 0;
const CONN_CONNECTING = 1;
const CONN_OK = 2;
const CONN_ERROR = 3;
const CONTROL_WS_URL = 'wss://' + window.location.host + '/api/ws/control';
const CONNECTED = 1; // line style
const DOTTED    = 2; // line style
const GRAPH_TIME = 60*60*24; // graph displays one day
const GRAPH_MIN_HEIGHT = 10;
const GRAPH_Y_NUMBER_INTERVAL = 5;
var domo;

function zeroPad(n, size) {
	let s = n.toString();
	while (s.length < size) {
		s = '0' + s;
	}
	return s;
}

function Domo() {
	this.sensors = {};
	this.actuators = {};
	this.connectionStatus = CONN_NONE;
	this.connection = null;
	this.reconnectCount = 0;
	this.lastScreenWidth = window.innerWidth;
	this.password = localStorage.password || localStorage.deviceSerial;

	let sensorData = JSON.parse(localStorage['sensors'] || '{}');
	for (let name in sensorData) {
		this.sensors[name] = {
			data: sensorData[name],
		};
	}
	for (let name of this.sensorKeys()) {
		this.redrawStats(name);
	}
	this.actuators = JSON.parse(localStorage['actuators'] || '{}');

	this.setupActuators();
	this.updateActuators(true);
	window.addEventListener('resize', this.onresize.bind(this));
	document.querySelector('#connectionStatus').addEventListener('click', function() {
		let password = prompt('What is the device password?', this.password || '');
		if (!password) return;
		this.password = password;
		if (localStorage.password != password) {
			localStorage.password = password;
			// TODO reconnect while connecting?
			if (this.connection) {
				this.connection.closeReason = 'reconnect';
				this.connection.close();
			} else if (this.connectionStatus === CONN_ERROR || this.connectionStatus === CONN_NONE) {
				this.connect();
			}
		}
	}.bind(this));

	this.connect();
}

Domo.prototype.connect = function() {
	this.setConnnectionStatus('Connecting...', CONN_CONNECTING);

	this.connection = new WebSocket(CONTROL_WS_URL);
	this.connection.onclose = function(e) {
		console.log('connection closed:', e);
		this.setConnnectionStatus('Connection closed', CONN_ERROR);
		let reason = this.connection.closeReason; // work-around
		this.connection = null;
		if (reason === 'reconnect') {
			// a reconnect was requested
			this.connect();
		} else if (reason === 'handshake-error') {
			// dont' reconnect
		} else {
			// probably a WebSocket protocol error
			this.reconnectCount++;
			// Reconnect after 200ms, 400ms, 800ms... 60s (max)
			setTimeout(this.connect.bind(this), Math.min(60000, 100*Math.pow(2, this.reconnectCount)));
		}
	}.bind(this);
	this.connection.onopen = function(e) {
		let lastLogTimes = {};
		for (let sensorName in this.sensors) {
			let lastTime = 0;
			if (this.sensors[sensorName].data) {
				let sensorLogs = this.sensors[sensorName].data.log;
				if (sensorLogs.length >= 1) {
					lastTime = sensorLogs[sensorLogs.length-1].time;
				}
			}
			lastLogTimes[sensorName] = {
				lastTime: lastTime,
			};
		}
		this.connection.send(JSON.stringify({
			'message': 'connect',
			'password': this.password,
			'lastLogTimes': lastLogTimes,
		}));
	}.bind(this);
	this.connection.onmessage = function(e) {
		let msg = JSON.parse(e.data);
		if (msg.message == 'connected') {
			console.log('connected');
			this.reconnectCount = 0;
			this.setConnnectionStatus('Connected', CONN_OK);

			this.updateSensorData(msg.logs);
			this.actuators = msg.actuators;
			this.updateActuators(true);

		} else if (msg.message == 'disconnected') {
			console.error('connection error: ' + msg.error);
			this.connection.closeReason = 'handshake-error';
			this.connection.close();

		} else if (msg.message == 'actuator') {
			this.actuators[msg.name] = msg.value;
			console.log('actuator:', msg.name, msg.value);
			this.updateActuators(true);

		} else if (msg.message == 'log') {
			this.addSensorLog(msg.sensor, msg.log);

		} else {
			console.warn('unknown message: ' + msg.message, msg);
		}
	}.bind(this);
}

Domo.prototype.setConnnectionStatus = function(message, status) {
	this.connectionStatus = status;
	let el = document.getElementById('connectionStatus');
	el.textContent = message;
	let statusClass;
	if (status === CONN_CONNECTING) {
		statusClass = 'connecting';
	} else if (status === CONN_OK) {
		statusClass = 'connected';
	} else if (status === CONN_ERROR || status === CONN_NONE) {
		statusClass = 'error';
	} else {
		console.error('unknown status');
		statusClass = '';
	}
	el.setAttribute('class', statusClass);
}

Domo.prototype.updateSensorData = function(sensorData) {
	for (let sensorName in sensorData) {
		if (!(sensorName in this.sensors)) {
			this.sensors[sensorName] = {};
		}
		let data = sensorData[sensorName];
		let olddata = this.sensors[sensorName].data;
		let sensor = this.sensors[sensorName];
		if (!olddata) {
			sensor.data = data;
		} else if (data.humanName !== olddata.humanName || data.type !== olddata.type || data.desiredValue !== olddata.desiredValue) {
			// data.name is an invariant (if it changed, the sensorName changes as well)
			sensor.data.humanName = data.humanName;
			sensor.data.type = data.type;
			sensor.data.desiredValue = data.desiredValue;
		} else if (!olddata.log || !olddata.log.length) {
			sensor.data.log = data.log;
		} else if (data.log.length == 0) {
			// no new data
			continue;
		} else if (olddata.log[olddata.log.length-1].time < data.log[data.log.length-1].time) {
			// add new data to existing data
			this.addSensorLog(sensorName, data.log);
			continue;
		} else {
			continue;
		}
		this.redrawStats(sensorName);
	}
	// remove old sensors, untested
	for (let name in this.sensors) {
		if (!(name in sensorData)) {
			delete this.sensors[name];
			// TODO remove the HTML element etc.
		}
	}
	this.saveSensors();
}

Domo.prototype.addSensorLog = function(sensorName, newlog) {
	let data = this.sensors[sensorName].data;
	let lastTime = 0;
	if (data.log.length > 0) {
		lastTime = data.log[data.log.length-1].time;
	}

	// add new log data
	for (let i=0; i<newlog.length; i++) {
		if (newlog[i].time <= lastTime) continue;
		data.log.push(newlog[i]);
	}

	// remove old log data
	if (data.log.length > 0) {
		lastTime = data.log[data.log.length-1].time; // update
		for (let i=0; i<data.log.length; i++) {
			// Remove log items that are off the graph, but keep one or two just
			// to the left of the graph (so the line will cross the border).
			if (data.log[i].time >= lastTime-GRAPH_TIME && i >= 2) {
				data.log = data.log.slice(i-1);
				break;
			}
		}
	}

	this.saveSensors();
	this.redrawStats(sensorName);
}

Domo.prototype.saveSensors = function() {
	let obj = {}
	for (let name in this.sensors) {
		obj[name] = this.sensors[name].data;
	}
	localStorage['sensors'] = JSON.stringify(obj);
}

Domo.prototype.saveActuators = function() {
	localStorage['actuators'] = JSON.stringify(this.actuators);
}

Domo.prototype.redrawStats = function(sensor) {
	let data = this.sensors[sensor].data;

	let oldDiv = document.querySelector('#stats-sensor-' + sensor);
	let div = document.querySelector('#templates > .stats').cloneNode(true);

	// Replace old stats with new one
	if (oldDiv === null) {
		document.querySelector('#stats').appendChild(div);
	} else {
		oldDiv.parentNode.insertBefore(div, oldDiv);
		oldDiv.remove();
	}
	div.id = 'stats-sensor-' + sensor;

	this.sensors[sensor].graph = {};
	this.redrawGraph(sensor);
}

Domo.prototype.sensorKeys = function() {
	// Put the sensors in a fixed order.
	let keys = [];
	for (let key in this.sensors) {
		keys.push(key);
	}
	keys.sort();
	for (let i=0; i<SENSOR_ORDER.length; i++) {
		let index = keys.indexOf(SENSOR_ORDER[i]);
		if (index > i) {
			// Put at the start of the array.
			keys.splice(i, 0, keys.pop(index));
		}
	}
	return keys;
}

Domo.prototype.redrawGraph = function(sensor) {
	let data = this.sensors[sensor].data;
	let now = new Date();
	let lastLog = data.log[data.log.length-1];
	let interval = lastLog ? lastLog.interval : 60;
	let timeEnd = Math.floor(now.getTime() / 1000.0 / interval) * interval + interval/2;
	let timeStart = timeEnd - GRAPH_TIME;
	let timeSpan = timeEnd - timeStart;
	let timeStep = 60*60*1; // 1 hour

	let graphWrapper = document.getElementById('stats-sensor-' + sensor);
	let graph = graphWrapper.querySelector('.stats-graph');
	let cs = getComputedStyle(graph);
	let graphWidth = parseFloat(cs.width);
	let graphHeight = parseFloat(cs.height);

	let valueMin = Infinity;
	let valueMax = -Infinity;
	for (let row of data.log) {
		if (row.value > valueMax) {
			valueMax = row.value;
		}
		if (row.value < valueMin) {
			valueMin = row.value;
		}
	}
	if (valueMin == Infinity || valueMax == -Infinity) {
		// Just so it won't fail.
		valueMin = 20;
		valueMax = 50;
	} else {
		valueMin -= 1;
		valueMax += 1;
		if (data.desiredValue) {
			// Make sure the desiredValue is visible.
			if (valueMin >= data.desiredValue) {
				valueMin = data.desiredValue - 1;
			} else if (valueMax <= data.desiredValue) {
				valueMax = data.desiredValue + 1;
			}
		}
		let diff = valueMax - valueMin;
		if (diff < GRAPH_MIN_HEIGHT) {
			valueMax += (GRAPH_MIN_HEIGHT - diff) / 2;
			valueMin -= (GRAPH_MIN_HEIGHT - diff) / 2;
		}
	}
	if (valueMin >= valueMax) {
		throw 'impossible: min > max';
	}

	let valueStep = 1;
	let valueSpan = valueMax - valueMin;

	let lastValueStr = lastLog ? lastLog.value.toFixed(1) : '(unknown)';
	if (data.type in UNITS) {
		lastValueStr += UNITS[data.type];
	}
	graphWrapper.querySelector('.stats-header').innerText = (data.humanName || sensor) + ' — ' + lastValueStr;

	if (graphWidth === this.sensors[sensor].graph.width) {
		return;
	}
	this.sensors[sensor].graph.width = graphWidth;

	// Utility functions
	function toGraphX(time) {
		return (time - timeStart) / timeSpan * graphWidth + 0.5;
	}
	function toGraphY(value) {
		return (valueMax - value) / valueSpan * graphHeight + 0.5;
	}
	function roundedCoord(coord) {
		return Math.round(coord*devicePixelRatio) / devicePixelRatio + 0.5;
	}

	// Resize canvas for hi-dpi screens
	// TODO
	//graph.setAttribute('height', Math.ceil(parseFloat(graph.getAttribute('data-height')) + 1/devicePixelRatio).toFixed(3)+'px');

	// Draw axes
	let gridStrokeWidth = (Math.max(1, Math.floor(devicePixelRatio*0.7)) / devicePixelRatio).toFixed(3)+'px';
	let grid = graph.querySelector('.grid');
	grid.innerHTML = '';
	for (let y=Math.ceil(valueMax)*1; y>=valueMin*1; y-=valueStep) {
		let v = y/1;
		let line;
		if (y % GRAPH_Y_NUMBER_INTERVAL === 0) {
			line = document.querySelector('#templates > .graph-grid-line-y1').cloneNode(true);
		} else {
			line = document.querySelector('#templates > .graph-grid-line-y2').cloneNode(true);
		}
		line.setAttribute('y1', roundedCoord(toGraphY(v)).toFixed(3)+'px');
		line.setAttribute('y2', roundedCoord(toGraphY(v)).toFixed(3)+'px');
		line.setAttribute('stroke-width', gridStrokeWidth);
		grid.appendChild(line);
		if (v % GRAPH_Y_NUMBER_INTERVAL === 0) {
			let text = document.querySelector('#templates > .graph-grid-text-y').cloneNode(true);
			text.setAttribute('y', roundedCoord(toGraphY(v)-2).toFixed(3)+'px');
			if (data.type in UNITS) {
				text.textContent = v + UNITS[data.type];
			} else {
				text.textContent = v;
			}
			grid.appendChild(text);
		}
	}
	// Get timezone offset.
	let localMidnight = new Date(now);
	localMidnight.setHours(0);
	let utcMidnight = new Date(now);
	utcMidnight.setUTCHours(0);
	let timezoneOffset = (utcMidnight.getTime() - localMidnight.getTime()) / 1000;
	while (timezoneOffset < 0) {
		timezoneOffset += 24*60*60;
	}
	for (let t=Math.ceil(timeStart/timeStep)*timeStep-timezoneOffset; t<=timeEnd; t+=timeStep) {
		let time = new Date(t*1000);
		let line;
		if (time.getHours() % 3 === 0) {
			line = document.querySelector('#templates > .graph-grid-line-x').cloneNode(true);
		} else {
			line = document.querySelector('#templates > .graph-grid-line-x2').cloneNode(true);
		}
		line.setAttribute('x1', roundedCoord(toGraphX(t)).toFixed(3)+'px');
		line.setAttribute('x2', roundedCoord(toGraphX(t)).toFixed(3)+'px');
		line.setAttribute('stroke-width', gridStrokeWidth);
		grid.appendChild(line);
		if (time.getHours() % 3 == 0 && t > timeStart+timeStep*0.7) {
			let text = document.querySelector('#templates > .graph-grid-text-x').cloneNode(true);
			text.setAttribute('x', roundedCoord(toGraphX(t)+1).toFixed(3)+'px');
			text.setAttribute('y', roundedCoord(toGraphY(Math.ceil(valueMin))-2).toFixed(3)+'px');
			text.textContent = time.getHours();
			grid.appendChild(text);
		}
	}

	// Draw curve
	let curve = graph.querySelector('.curve');
	curve.innerHTML = '';
	let path = null;
	let lineStyle = null;
	let path_d = '';
	let prevRow = null;
	function addGraphPath() {
		if (path === null) return;
		path.setAttribute('d', path_d);
		graph.querySelector('.curve').appendChild(path);
		path = null;
		path_d = '';
	}
	for (let row of data.log) {
		let newLineStyle = lineStyle;
		if (prevRow == null || Math.abs(row.time - prevRow.time) <= Math.max(row.interval, prevRow.interval)) {
			newLineStyle = CONNECTED;
		} else {
			newLineStyle = DOTTED;
		}
		if (newLineStyle !== lineStyle) {
			addGraphPath();
			lineStyle = newLineStyle;
			if (lineStyle === DOTTED) {
				path = document.querySelector('#templates > .graph-curve-dotted').cloneNode(true);
			} else if (lineStyle === CONNECTED) {
				path = document.querySelector('#templates > .graph-curve-connected').cloneNode(true);
			} else {
				throw 'Unknown line style';
			}
			if (prevRow !== null) {
				path_d = 'M';
				let x = toGraphX(prevRow.time);
				let y = toGraphY(prevRow.value);
				path_d += x.toFixed(2) + ' ' + y.toFixed(2);
			}
		}
		if (path_d) {
			path_d += ' L';
		} else {
			path_d += 'M';
		}
		let x = toGraphX(row.time);
		let y = toGraphY(row.value);
		path_d += x.toFixed(2) + ' ' + y.toFixed(2);
		prevRow = row;
	}
	addGraphPath();
}

Domo.prototype.setupActuators = function() {
	// TODO remove duplication with updateActuators
	let actuators = document.querySelectorAll('.actuator');
	// for .. of is not supported for NodeList in Chrome
	for (let i_ac=0; i_ac<actuators.length; i_ac++) {
		let div = actuators[i_ac];
		let actuatorName = div.dataset.actuator;
		let inputList = div.querySelectorAll('[name]');
		for (let i_il=0; i_il<inputList.length; i_il++) {
			let input = inputList[i_il];
			let tagName = input.tagName.toLowerCase();
			if (tagName == 'select' || tagName == 'input' && (input.type == 'checkbox' || input.type == 'radio')) {
				input.addEventListener('change', (e) => {
					this.updateActuatorInput(actuatorName, input);
				});
			} else {
				input.addEventListener('input', (e) => {
					this.updateActuatorInput(actuatorName, input);
				});
			}
		}
	}
}

Domo.prototype.updateActuatorInput = function(actuatorName, input) {
	let value = input.value;

	if (input.type === 'checkbox') {
		value = input.checked;

	} else if (input.type === 'range') {
		value = input.valueAsNumber;
		if ('exp' in input.dataset) {
			value = Math.exp(value);
		}
	}

	if ('type' in input.dataset) {
		let time = new Date((Math.floor(Date.now() / 1000 / 86400) * 86400 + this.actuators[actuatorName][input.name]) * 1000);
		if (input.dataset.type == 'hours-tz') {
			time.setHours(value);
			value = time.getTime() / 1000 % 86400;
		} else if (input.dataset.type == 'minutes-tz') {
			time.setMinutes(value);
			value = time.getTime() / 1000 % 86400;
		} else if (input.dataset.type == 'minutes') {
			value = value * 60;
		}
	}

	let actuator = this.actuators[actuatorName];
	if (actuator[input.name] === value) return;
	actuator[input.name] = value;
	console.log(input.name, value);
	this.updateActuators(false);

	// Send new value
	if (this.connectionStatus == CONN_OK) {
		this.connection.send(JSON.stringify({
			message: 'actuator',
			name: actuatorName,
			value: actuator,
		}));
	} else {
		// TODO queue this change?
		console.warn('not connected - change will be discarded');
	}
}

Domo.prototype.getSliderContainer = (input) => {
	// find the parent <div class="slider">
	let slider = input;
	while (slider && !slider.classList.contains('slider')) {
		slider = slider.parentNode;
	}
	return slider;
}

Domo.prototype.updateSliderDisplay = function(input, value) {
	let displayValue;
	if (input.dataset.unit) {
		if (input.dataset.unit == 'time') {
			displayValue = '';
			let origValue = value;
			let minutes = Math.floor(value/60);
			displayValue += zeroPad(minutes, 2) + ':';
			value -= minutes*60;
			displayValue += zeroPad(Math.round(value), 2);
		} else {
			displayValue = value.toFixed(0) + input.dataset.unit;
		}
	} else {
		displayValue = (value/parseFloat(input.max)*100).toFixed(1)+'%';
	}
	this.getSliderContainer(input).querySelector('.sliderValue').textContent = displayValue;
}

Domo.prototype.updateActuators = function(updateInputs) {
	this.saveActuators();

	let actuators = document.querySelectorAll('.actuator');
	// for .. of is not supported for NodeList in Chrome
	for (let i_ac=0; i_ac<actuators.length; i_ac++) {
		let div = actuators[i_ac];
		let actuatorName = div.dataset.actuator;
		let actuator = this.actuators[actuatorName];
		if (!actuator) continue;
		let inputList = div.querySelectorAll('[name]');
		for (let i_il=0; i_il<inputList.length; i_il++) {
			let input = inputList[i_il];
			let enabled = true;

			// Enable inputs based on knowing what actuator it is and how it
			// works.
			if (actuatorName === 'colorlight') {
				enabled = false;
				if (input.name === 'mode' || input.name == 'disabled') {
					enabled = true;
				} else if (actuator.mode === 'hsv' || actuator.mode === 'hsv-max') {
					if ((input.name === 'time' || input.name == 'reverse') && actuator.looping) {
						enabled = true;
					} else if (input.name === 'hue' && !actuator.looping) {
						enabled = true;
					} else if (input.name === 'saturation' || input.name === 'value' || input.name == 'looping') {
						enabled = true;
					}
				} else if (actuator.mode === 'rgb') {
					if (['red', 'green', 'blue'].indexOf(input.name) > -1) {
						enabled = true;
					}
				} else {
					console.warn('unknown mode');
				}
			}

			input.disabled = !enabled;
			if (input instanceof HTMLInputElement && input.type === 'range') {
				let container = this.getSliderContainer(input);
				if (enabled) {
					container.classList.add('visible');
				} else {
					container.classList.remove('visible');
				}
			}

			if (updateInputs) {
				if (input.type == 'checkbox') {
					input.checked = actuator[input.name];

				} else if (input.type == 'radio') {
					input.checked = input.value == actuator[input.name];

				} else {
					let value = actuator[input.name];

					// Logarithmic scale.
					if ('exp' in input.dataset) {
						value = Math.log(value);
					}

					if ('type' in input.dataset) {
						// Calculate hour/minutes etc from seconds.
						let time = new Date((Math.floor(Date.now() / 1000 / 86400) * 86400 + value) * 1000);

						if (input.dataset.type == 'minutes') {
							value = value / 60;
						} else if (input.dataset.type == 'hours-tz') {
							value = time.getHours();
						} else if (input.dataset.type == 'minutes-tz') {
							value = time.getMinutes();
						} else {
							console.warn('unknown type: ' + input.dataset.type);
						}
					}

					input.value = value;
				}
			}
			if (input.type == 'range') {
				this.updateSliderDisplay(input, actuator[input.name]);
			}
		}
	}
}

Domo.prototype.onresize = function() {
	// FIXME forcing a layout here
	window.requestAnimationFrame(function() {
		for (let sensor in this.sensors) {
			let graphWrapper = document.getElementById('stats-sensor-' + sensor);
			let width = getComputedStyle(graphWrapper).width;
			if (width === this.sensors[sensor].previousWidth || graphWrapper.offsetParent === null) {
				// graphWrapper.offsetParent is null when it is not displayed (display:
				// none). This happens when it is hidden via the tab bar.
				// https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/offsetParent
				// Do not redraw in that case.
				continue;
			}
			console.log('redrawing ' + sensor);
			this.sensors[sensor].previousWidth = width;
			this.redrawGraph(sensor);
		}
	}.bind(this));
}

function onload() {
	domo = new Domo();
}

if (document.readyState === 'loading') {
	window.addEventListener('DOMContentLoaded', onload);
} else {
	onload();
}
