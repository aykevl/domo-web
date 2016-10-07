'use strict';

const UNITS = {
	'temperature': '°C',
};
const CONN_NONE = 0;
const CONN_CONNECTING = 1;
const CONN_OK = 2;
const CONN_ERROR = 3;
const CONTROL_WS_URL = 'wss://' + window.location.host + '/api/ws/control';
const CONNECTED = 1; // line style
const DOTTED    = 2; // line style
const GRAPH_TIME = 60*60*24; // graph displays one day
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
	this.deviceSerial = localStorage.deviceSerial;

	let sensorData = JSON.parse(localStorage['sensors'] || '{}');
	for (let name in sensorData) {
		this.sensors[name] = {
			data: sensorData[name],
		};
		this.redrawStats(name);
	}
	this.actuators = JSON.parse(localStorage['actuators'] || '{}');

	this.setupActuators();
	this.updateActuators(true);
	window.addEventListener('resize', this.onresize.bind(this));
	document.querySelector('#connectionStatus').addEventListener('click', function() {
		let deviceSerial = prompt('What is the device serial number?', this.deviceSerial || '');
		if (!deviceSerial) return;
		this.deviceSerial = deviceSerial;
		if (localStorage.deviceSerial != deviceSerial) {
			localStorage.deviceSerial = deviceSerial;
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
			'deviceSerial': this.deviceSerial,
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
		} else if (data.humanName != olddata.humanName || data.type != olddata.type) {
			// data.name is an invariant (if it changed, the sensorName changes as well)
			sensor.data.humanName = data.humanName;
			sensor.data.type = data.type;
		} else if (!olddata.log || !olddata.log.length) {
			sensor.data.log = data.log;
		} else if (data.log.length == 0) {
			// no new data
			return;
		} else if (olddata.log[olddata.log.length-1].time < data.log[data.log.length-1].time) {
			// add new data to existing data
			this.addSensorLog(sensorName, data.log);
			return;
		} else {
			return;
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

	div.querySelector('.stats-header').innerText = data.humanName || sensor;

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

Domo.prototype.redrawGraph = function(sensor) {
	let data = this.sensors[sensor].data;
	let now = new Date();
	let interval = data.log[data.log.length-1].interval;
	let timeEnd = Math.floor(now.getTime() / 1000.0 / interval) * interval + interval/2;
	let timeStart = timeEnd - GRAPH_TIME;
	let timeSpan = timeEnd - timeStart;
	let timeStep = 60*60*1; // 1 hour

	let graph = document.querySelector('#stats-sensor-' + sensor + ' .stats-graph');
	let cs = getComputedStyle(graph);
	let graphWidth = parseFloat(cs.width);
	let graphHeight = parseFloat(cs.height);
	let valueMin = 14.5;
	let valueMax = 33.5;
	let valueStep = 1;
	let valueSpan = valueMax - valueMin;

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
	for (let y=Math.ceil(valueMax)*5; y>=valueMin*5; y-=valueStep) {
		let v = y / 5;
		let line;
		if (y % 25 === 0) {
			line = document.querySelector('#templates > .graph-grid-line-y1').cloneNode(true);
		} else if (y % 5 === 0) {
			line = document.querySelector('#templates > .graph-grid-line-y2').cloneNode(true);
		} else {
			line = document.querySelector('#templates > .graph-grid-line-y3').cloneNode(true);
		}
		line.setAttribute('y1', roundedCoord(toGraphY(v)).toFixed(3)+'px');
		line.setAttribute('y2', roundedCoord(toGraphY(v)).toFixed(3)+'px');
		line.setAttribute('stroke-width', gridStrokeWidth);
		grid.appendChild(line);
		if (y % 25 === 0) {
			let text = document.querySelector('#templates > .graph-grid-text-y').cloneNode(true);
			text.setAttribute('y', roundedCoord(toGraphY(v)-2).toFixed(3)+'px');
			text.textContent = v + UNITS[data.type];
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
			if (input.tagName.toLowerCase() == 'input' && input.type == 'checkbox') {
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
	if (input.tagName.toLowerCase() == 'input') {
		if (input.type == 'checkbox') {
			value = input.checked;
		} else if (input.type == 'range') {
			value = input.valueAsNumber;
			if ('exp' in input.dataset) {
				value = Math.exp(value);
			}
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
			let enabled = false;

			// Enable inputs based on knowing what actuator it is and how it
			// works.
			if (actuatorName === 'color') {
				if (actuator.isWhite) {
					enabled = input.name === 'isWhite';
				} else if (input.name === 'mode' || input.name === 'isWhite' || input.name === 'looping') {
					enabled = true;
				} else if (actuator.mode === 'hsv' || actuator.mode === 'hsv-max') {
					if (input.name === 'time' && actuator.looping) {
						enabled = true;
					} else if (input.name === 'hue' && !actuator.looping) {
						enabled = true;
					} else if (input.name === 'saturation' || input.name === 'value') {
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
				} else {
					if ('exp' in input.dataset) {
						input.value = Math.log(actuator[input.name]);
					} else {
						input.value = actuator[input.name];
					}
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
	let screenWidth = document.documentElement.clientWidth;
	if (screenWidth !== this.lastScreenWidth) {
		this.lastScreenWidth = screenWidth;
		window.requestAnimationFrame(function() {
			for (let sensor in this.sensors) {
				this.redrawGraph(sensor);
			}
		}.bind(this));
	}
}

function onload() {
	domo = new Domo();
}

if (document.readyState === 'loading') {
	window.addEventListener('DOMContentLoaded', onload);
} else {
	onload();
}
