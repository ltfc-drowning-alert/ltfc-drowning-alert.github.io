(async () => {
	"use strict";

	class Camera {
		constructor(deviceId, deviceLabel, videoElement) {
			this.deviceId = deviceId;
			this.deviceLabel = deviceLabel;
			this.probabilityRecords = [];
			this.videoElement = videoElement;
		}

		async start() {
			stop();
			this.videoElement.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: this.deviceId } } });
			await this.videoElement.play();
		}

		stop() {
			if (this.videoElement.srcObject !== null) {
				for (const track of this.videoElement.srcObject.getTracks()) {
					track.stop();
				}
				this.videoElement.srcObject = null;
			}
		}
	}

	const modelBaseUrl = "model/"
	const model = await tmImage.load(`${modelBaseUrl}model.json`, `${modelBaseUrl}metadata.json`);

	const alarm = new Tone.Oscillator({
		"volume": -16,
		"detune": 0,
		"frequency": 440,
		"partialCount": 0,
		"phase": 0,
		"type": "square"
	}).toDestination();

	document.body.classList.remove("loading");

	const cameraSelect = document.getElementById("cameraSelect");
	const cameraSelect_JQ = $(cameraSelect);
	const cameraContainer = document.getElementById("cameras");
	const activeCameras = new Map();
	const cameraTemplate = document.getElementById("cameraTemplate");

	function clearChildNodes(element) {
		for (let c = element.firstChild; c !== null; c = element.firstChild) {
			element.removeChild(c);
		}
	}

	async function addCamera(deviceId, deviceLabel) {
		const cameraTemplateInstance = document.importNode(cameraTemplate.content, true);
		const c = new Camera(deviceId, deviceLabel, cameraTemplateInstance.querySelector("video"));
		await c.start();
		cameraContainer.appendChild(cameraTemplateInstance);
		activeCameras.set(deviceId, c);
	}

	function removeCameras(test) {
		if (test === undefined) {
			test = () => true;
		}
		for (const [id, c] of activeCameras) {
			if (test(id)) {
				c.stop();
				cameraContainer.removeChild(c.videoElement.parentElement);
				activeCameras.delete(id);
			}
		}
	}

	async function ensureCameraPermission() {
		try {
			if ((await navigator.permissions.query({ name: "camera" })).state === "granted") {
				return;
			}
		}
		catch (e) {}
		for (const track of (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks()) {
			track.stop();
		}
	}

	async function updateDeviceList() {
		try {
			clearChildNodes(cameraSelect);
			await ensureCameraPermission();
			const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
			if (devices.length === 0) {
				removeCameras();
			}
			else {
				for (const device of devices) {
					const option = document.createElement("option");
					option.setAttribute("value", device.deviceId);
					if (activeCameras.has(device.deviceId)) {
						option.setAttribute("selected", "");
					}
					option.textContent = device.label;
					cameraSelect.appendChild(option);
				}
				const connectedDeviceIds = devices.map(d => d.deviceId);
				removeCameras(id => connectedDeviceIds.includes(id) === false);
			}
			cameraSelect_JQ.selectpicker("refresh");
		}
		catch (e) {
			console.error(e);
		}
	}

	navigator.mediaDevices.addEventListener("devicechange", updateDeviceList);

	await updateDeviceList();

	cameraSelect_JQ.on("hide.bs.select", async () => {
		const selectedOptions = [...cameraSelect.selectedOptions];
		if (selectedOptions.length === 0) {
			removeCameras();
		}
		else {
			const selectedCameraIds = selectedOptions.map(o => o.value);
			removeCameras(id => selectedCameraIds.includes(id) === false);
			for (const o of selectedOptions) {
				const id = o.value;
				if (activeCameras.has(id) === false) {
					await addCamera(id, o.textContent);
				}
			}
		}
	});

	let continuePrediction = false;
	let sampleSize = 100;
	let probabilityThreshold = 0.5;

	const alertRuleForm = document.getElementById("alertRuleForm");
	const editButton = document.getElementById("editButton");
	const editModeButtons = document.getElementById("editModeButtons");
	const sampleSizeInput = document.getElementById("sampleSizeInput");
	const probabilityThresholdInput = document.getElementById("probabilityThresholdInput");

	alertRuleForm.addEventListener("submit", e => {
		e.preventDefault();

		sampleSize = +sampleSizeInput.value;
		probabilityThreshold = probabilityThresholdInput.value / 100;

		sampleSizeInput.setAttribute("value", sampleSizeInput.value);
		sampleSizeInput.setAttribute("disabled", "");
		probabilityThresholdInput.setAttribute("value", probabilityThresholdInput.value);
		probabilityThresholdInput.setAttribute("disabled", "");
		editModeButtons.classList.add("d-none");
		for (const c of editModeButtons.children) {
			c.setAttribute("disabled", "");
		}
		editButton.removeAttribute("disabled");
		editButton.classList.remove("d-none");
	});

	editButton.addEventListener("click", () => {
		sampleSizeInput.removeAttribute("disabled");
		probabilityThresholdInput.removeAttribute("disabled");
		editModeButtons.classList.remove("d-none");
		for (const c of editModeButtons.children) {
			c.removeAttribute("disabled");
		}
		editButton.setAttribute("disabled", "");
		editButton.classList.add("d-none");
		sampleSizeInput.select();
	});

	function drawVideoToCanvas(videoElement) {
		const canvas = document.createElement("canvas");
		canvas.width = videoElement.videoWidth;
		canvas.height = videoElement.videoHeight;
		const context = canvas.getContext("2d");
		context.drawImage(videoElement, 0, 0, videoElement.videoWidth, videoElement.videoHeight);
		return canvas;
	}

	const detectionSwitch = document.getElementById("detectionSwitch");
	const detectionFrameRateDisplay = document.getElementById("detectionFrameRate");
	const visualAlert = $(document.getElementById("visualAlert"));
	let lastPredictionTime = 0;
	let isAudioAlarmOn = false;
	let isTestMode = false;

	visualAlert.on("show.bs.modal", () => {
		alarm.start();
	});

	visualAlert.on("hide.bs.modal", () => {
		alarm.stop();
	});

	async function predictLoop(timestamp) {
		if (continuePrediction === false) {
			return;
		}
		if (activeCameras.size === 0) {
			detectionSwitch.switchButton("off");
			return;
		}
		if (lastPredictionTime > 0) {
			detectionFrameRateDisplay.textContent = (1000 / (timestamp - lastPredictionTime)).toFixed(2);
		}
		lastPredictionTime = timestamp;
		const cameras = [...activeCameras.values()];
		processResults(cameras, await Promise.allSettled(cameras.map(c => model.predict(drawVideoToCanvas(c.videoElement)))));
	}

	function processResults(cameras, results) {
		if (continuePrediction === false) {
			return;
		}
		if (activeCameras.size === 0) {
			detectionSwitch.switchButton("off");
			return;
		}
		let hasPossibleDrowning = false;
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			const probabilityRecords = cameras[i].probabilityRecords;
			if (result.status !== "fulfilled") {
				console.error(result);
				continue;
			}
			const drowningProbability = result.value[0].probability;
			if (probabilityRecords.length >= sampleSize) {
				probabilityRecords.splice(0, probabilityRecords.length - sampleSize + 1);
			}
			probabilityRecords.push(drowningProbability);
			const cameraContainer = cameras[i].videoElement.parentElement;
			if (probabilityRecords.length === sampleSize) {
				const avgProbability = probabilityRecords.reduce((accumulator, currentValue) => accumulator + currentValue, 0) / sampleSize;
				cameraContainer.querySelector(".probability").textContent = (avgProbability * 100).toFixed(2) + "%";
				if (avgProbability >= probabilityThreshold) {
					cameraContainer.classList.add("alertTarget");
					hasPossibleDrowning = true;
					if (isTestMode === true) {
						if (isAudioAlarmOn === false) {
							alarm.start();
							isAudioAlarmOn = true;
						}
					}
					else {
						visualAlert.modal("show");
					}
				}
				else {
					cameraContainer.classList.remove("alertTarget");
				}
			}
			else {
				cameraContainer.querySelector(".probability").textContent = "---";
			}
		}
		if (hasPossibleDrowning === false) {
			if (isTestMode === true && isAudioAlarmOn === true) {
				alarm.stop();
				isAudioAlarmOn = false;
			}
		}
		window.requestAnimationFrame(predictLoop);
	}
	
	detectionSwitch.addEventListener("change", () => {
		if (detectionSwitch.checked) {
			if (continuePrediction === false) {
				continuePrediction = true;
				window.requestAnimationFrame(predictLoop);
			}
		}
		else {
			alarm.stop();
			continuePrediction = false;
			lastPredictionTime = 0;
			detectionFrameRateDisplay.textContent = "-";
			for (const c of activeCameras.values()) {
				c.probabilityRecords.splice(0);
				const cameraContainer = c.videoElement.parentElement;
				cameraContainer.classList.remove("alertTarget");
				cameraContainer.querySelector(".probability").textContent = "";
			}
		}
	});

	const testModeSwitch = document.getElementById("testModeSwitch");
	testModeSwitch.addEventListener("change", () => {
		isTestMode = testModeSwitch.checked;
	});
})();