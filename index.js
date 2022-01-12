var instance_skel = require('../../instance_skel')
let os = require('os')
var exec = require('child_process').exec
var GetUpgradeScripts = require('./upgrades')
var debug
var log

function instance(system, id, config) {
	var self = this

	self.system = system

	self.instance_errors = 0
	self.instance_warns = 0
	self.instance_oks = 0
	self.instance_status = {}

	self.system.on('instance_errorcount', function (errcount) {
		self.instance_status = errcount[3]
		self.instance_errors = errcount[2]
		self.instance_warns = errcount[1]
		self.instance_oks = errcount[0]

		self.setVariables({
			instance_errors: self.instance_errors,
			instance_warns: self.instance_warns,
			instance_oks: self.instance_oks,
		})

		self.checkFeedbacks('instance_status')
	})

	self.time_interval = setInterval(function () {
		const now = new Date()
		const hh = `0${now.getHours()}`.slice(-2)
		const mm = `0${now.getMinutes()}`.slice(-2)
		const ss = `0${now.getSeconds()}`.slice(-2)
		const month = `0${now.getMonth() + 1}`.slice(-2)
		const day = `0${now.getDate()}`.slice(-2)
		const hhmm = hh + ':' + mm
		const hhmmss = hhmm + ':' + ss
		self.setVariables({
			date_y: now.getFullYear(),
			date_m: month,
			date_d: day,
			time_hms: hhmmss,
			time_hm: hhmm,
			time_h: hh,
			time_m: mm,
			time_s: ss,
		})
	}, 1000)

	// super-constructor
	instance_skel.apply(this, arguments)

	return self
}

instance.GetUpgradeScripts = GetUpgradeScripts

instance.prototype.init = function () {
	var self = this

	debug = self.debug
	log = self.log

	self.callbacks = {}
	self.instances = {}
	self.active = {}
	self.pages = {}
	self.bank_info = {}
	self.pageHistory = {}
	self.custom_variables = {}

	self.feedback_variable_subscriptions = {}

	self.CHOICES_INSTANCES = []
	self.CHOICES_SURFACES = []
	self.CHOICES_PAGES = []
	self.CHOICES_BANKS = [{ label: 'This button', id: 0 }]
	self.CHOICES_VARIABLES = []

	for (var bank = 1; bank <= global.MAX_BUTTONS; bank++) {
		self.CHOICES_BANKS.push({ label: bank, id: bank })
	}

	self.BUTTON_ACTIONS = [
		'button_pressrelease',
		'button_press',
		'button_release',
		'button_text',
		'textcolor',
		'bgcolor',
		'panic_bank',
	]

	self.PAGE_ACTIONS = ['set_page', 'set_page_byindex', 'inc_page', 'dec_page']

	self.pages_getall()
	self.addSystemCallback('page_update', self.pages_update.bind(self))

	self.devices_getall()
	self.addSystemCallback('devices_list', self.devices_list.bind(self))

	self.bind_ip_get()
	self.addSystemCallback('ip_rebind', self.bind_ip_get.bind(self))

	self.banks_getall()
	self.addSystemCallback('graphics_bank_invalidate', self.bank_invalidate.bind(self))

	self.addSystemCallback('graphics_indicate_push', self.bank_indicate_push.bind(self))

	self.instance_save()
	self.addSystemCallback('instance_save', self.instance_save.bind(self))

	self.addSystemCallback('variable_instance_definitions_set', self.variable_list_update.bind(self))
	self.addSystemCallback('variables_changed', self.variables_changed.bind(self))
	self.variable_list_update()

	self.addSystemCallback('custom_variables_update', self.custom_variable_list_update.bind(self))
	self.custom_variable_list_update()

	// self.init_feedback() // called by variable_list_update
	self.checkFeedbacks()
	self.update_variables()

	self.subscribeFeedbacks('variable_value')
	self.subscribeFeedbacks('variable_variable')

	self.status(self.STATE_OK)
}

instance.prototype.bind_ip_get = function () {
	var self = this
	var adapters = getNetworkInterfaces.apply(self)
	var ip = ''

	const new_values = {}

	for (let i in adapters) {
		new_values[adapters[i].name] = adapters[i].address
		ip += adapters[i].address + '\\n'
	}

	new_values['all_ip'] = ip
	self.setVariables(new_values)

	self.system.emit('config_get', 'bind_ip', function (bind_ip) {
		self.setVariable('bind_ip', bind_ip)
	})
}

instance.prototype.pages_getall = function () {
	var self = this

	self.system.emit('get_page', function (pages) {
		self.pages = pages
	})
}

instance.prototype.pages_update = function () {
	var self = this

	// Update dropdowns
	self.init_actions()
}

instance.prototype.banks_getall = function () {
	var self = this

	system.emit('db_get', 'bank', function (banks) {
		self.banks = banks

		const new_values = {}

		for (var p in banks) {
			for (var b in banks[p]) {
				var tb = banks[p][b]
				var k = `${p}_${b}`
				var v = `b_text_${k}`
				if (tb.style === 'png') {
					// need a copy, not a reference
					self.bank_info[k] = JSON.parse(JSON.stringify(tb))
					new_values[v] = self.bank_info[k].text = self.check_var_recursion(v, tb.text)
				} else {
					new_values[v] = undefined
				}
			}
		}

		self.setVariables(new_values)
	})
}

instance.prototype.custom_variable_list_update = function (data) {
	const self = this

	if (data) {
		self.custom_variables = data
	} else {
		self.system.emit('custom_variables_get', (d) => {
			self.custom_variables = d
		})
	}

	self.update_variables()

	self.init_actions()
}

instance.prototype.check_var_recursion = function (v, realText) {
	var self = this
	var newText

	if (realText) {
		if (realText.includes(v)) {
			// recursion error:
			// button trying to include itself
			newText = '$RE'
		} else {
			system.emit('variable_parse', realText, function (str) {
				newText = str
			})
		}
	}
	return newText
}

instance.prototype.bank_invalidate = function (page, bank) {
	var self = this
	var k = `${page}_${bank}`
	var v = `b_text_${k}`
	var oldText
	var newText
	var realText = self.banks[page][bank].text

	if (!self.bank_info[k]) {
		// new key
		self.bank_info[k] = JSON.parse(JSON.stringify(self.banks[page][bank]))
	}
	if (self.bank_info[k].text) {
		oldText = self.bank_info[k].text
	}

	newText = self.check_var_recursion(v, realText)

	if (oldText !== newText) {
		self.bank_info[k].text = newText
		self.setVariable(`b_text_${k}`, newText)
	} else {
		// feedback/color change
		// Fetch feedback-overrides for bank
		var o = self.bank_info[k]
		var n = JSON.parse(JSON.stringify(self.banks[page][bank]))
		var changed = false
		system.emit('feedback_get_style', page, bank, function (style) {
			// feedback override?
			if (style !== undefined) {
				n = style
			}
			for (var key of ['color', 'bgcolor']) {
				changed = changed || o[key] != n[key]
				o[key] = n[key]
			}
		})
		if (changed) {
			self.checkFeedbacks('bank_style')
		}
	}
}

instance.prototype.bank_indicate_push = function (page, bank, state) {
	var self = this

	self.checkFeedbacks('bank_pushed')
}

instance.prototype.devices_list = function (list) {
	var self = this

	self.devices = list
	self.init_actions()
}

instance.prototype.devices_getall = function () {
	var self = this

	self.system.emit('devices_list_get', function (list) {
		self.devices = list
	})
}

instance.prototype.variable_list_update = function () {
	var self = this

	self.system.emit('variable_get_definitions', function (list) {
		self.CHOICES_VARIABLES = []
		for (const [id, variables] of Object.entries(list)) {
			for (const variable of variables) {
				const v = `${id}:${variable.name}`
				self.CHOICES_VARIABLES.push({ label: `${v} - ${variable.label}`, id: v })
			}
		}
	})

	self.init_feedback()
}
instance.prototype.variables_changed = function (changed_variables, removed_variables) {
	var self = this

	const all_changed_variables = new Set([...removed_variables, ...Object.keys(changed_variables)])

	let affected_ids = []

	for (const [id, names] of Object.entries(self.feedback_variable_subscriptions)) {
		for (const name of names) {
			if (all_changed_variables.has(name)) {
				affected_ids.push(id)
				break
			}
		}
	}

	if (affected_ids.length > 0) {
		self.checkFeedbacksById(...affected_ids)
	}
}

instance.prototype.instance_save = function () {
	var self = this

	self.system.emit('instance_getall', self.instance_getall.bind(self))
}

instance.prototype.instance_getall = function (instances, active) {
	var self = this
	self.instances = instances
	self.active = active
	self.CHOICES_INSTANCES.length = 0

	for (var key in self.instances) {
		if (self.instances[key].label !== 'internal') {
			self.CHOICES_INSTANCES.push({ label: self.instances[key].label, id: key })
		}
	}

	self.init_actions()

	self.init_feedback()
}

instance.prototype.addSystemCallback = function (name, cb) {
	var self = this

	if (self.callbacks[name] === undefined) {
		self.callbacks[name] = cb.bind(self)
		self.system.on(name, cb)
	}
}

instance.prototype.removeAllSystemCallbacks = function () {
	var self = this

	for (var key in self.callbacks) {
		self.system.removeListener(key, self.callbacks[key])
		delete self.callbacks[key]
	}
}

instance.prototype.updateConfig = function (config) {
	var self = this
	self.config = config
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this

	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module exposes internal functions of companion and does not have any configuration options',
		},
	]
}

// When module gets deleted
instance.prototype.destroy = function () {
	var self = this
	if (self.time_interval) {
		clearInterval(self.time_interval)
	}
	self.removeAllSystemCallbacks()
}

instance.prototype.init_actions = function (system) {
	var self = this

	self.CHOICES_SURFACES.length = 0
	self.CHOICES_SURFACES.push({
		label: 'Current surface',
		id: 'self',
	})

	for (const device of self.devices) {
		self.CHOICES_SURFACES.push({
			label: `${device.name || device.type} (${device.serialnumber})`,
			id: device.serialnumber,
		})
	}

	self.CHOICES_PAGES = [{ label: 'This page', id: 0 }]

	for (var page in self.pages) {
		var name = page

		if (self.pages[page].name !== undefined && self.pages[page].name != 'PAGE') {
			name += ' (' + self.pages[page].name + ')'
		}
		self.CHOICES_PAGES.push({
			label: name,
			id: page,
		})
	}

	actions = {
		instance_control: {
			label: 'Enable or disable instance',
			options: [
				{
					type: 'dropdown',
					label: 'Instance',
					id: 'instance_id',
					default: self.CHOICES_INSTANCES.length > 0 ? self.CHOICES_INSTANCES[0].id : undefined,
					choices: self.CHOICES_INSTANCES,
				},
				{
					type: 'dropdown',
					label: 'Enable',
					id: 'enable',
					default: 'true',
					choices: self.CHOICES_YESNO_BOOLEAN,
				},
			],
		},
		set_page: {
			label: 'Set surface with s/n to page',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
				{
					type: 'dropdown',
					label: 'Page',
					id: 'page',
					default: '1',
					choices: [{ id: 'back', label: 'Back' }, { id: 'forward', label: 'Forward' }, ...self.CHOICES_PAGES],
				},
			],
		},
		set_page_byindex: {
			label: 'Set surface with index to page',
			options: [
				{
					type: 'number',
					label: 'Surface / controller',
					id: 'controller',
					tooltip: 'Emulator is 0, all other controllers in order of type and serial-number',
					min: 0,
					max: 100,
					default: 0,
					required: true,
					range: false,
				},
				{
					type: 'dropdown',
					label: 'Page',
					id: 'page',
					default: '1',
					choices: [{ id: 'back', label: 'Back' }, { id: 'forward', label: 'Forward' }, ...self.CHOICES_PAGES],
				},
			],
		},
		set_brightness: {
			label: 'Set surface with s/n brightness',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
				{
					type: 'number',
					label: 'Brightness',
					id: 'brightness',
					default: 100,
					min: 0,
					max: 100,
					step: 1,
					range: true,
				},
			],
		},
		lockout_device: {
			label: 'Trigger a device to lockout immediately.',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
			],
		},
		unlockout_device: {
			label: 'Trigger a device to unlock immediately.',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
			],
		},
		exec: {
			label: 'Run shell path (local)',
			options: [
				{
					type: 'textinput',
					label: 'Path (supports variables in path)',
					id: 'path',
				},
				{
					type: 'number',
					label: 'Timeout (ms, between 500 and 20000)',
					id: 'timeout',
					default: 5000,
					min: 500,
					max: 20000,
					required: true,
				},
			],
		},
		lockout_all: {
			label: 'Trigger all devices to lockout immediately.',
		},
		unlockout_all: {
			label: 'Trigger all devices to unlock immediately.',
		},
		inc_page: {
			label: 'Increment page number',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
			],
		},
		dec_page: {
			label: 'Decrement page number',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES,
				},
			],
		},

		button_pressrelease: {
			label: 'Button press and release',
			options: [
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},

		button_press: {
			label: 'Button Press',
			options: [
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},

		button_release: {
			label: 'Button Release',
			options: [
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},

		button_text: {
			label: 'Button Text',
			options: [
				{
					type: 'textinput',
					label: 'Button Text',
					id: 'label',
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},

		textcolor: {
			label: 'Button Text Color',
			options: [
				{
					type: 'colorpicker',
					label: 'Text Color',
					id: 'color',
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},

		bgcolor: {
			label: 'Button Background Color',
			options: [
				{
					type: 'colorpicker',
					label: 'Background Color',
					id: 'color',
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
			],
		},
		rescan: {
			label: 'Rescan USB for devices',
		},

		panic_bank: {
			label: 'Abort actions on button',
			options: [
				{
					type: 'dropdown',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
					default: '0',
					choices: self.CHOICES_PAGES,
				},
				{
					type: 'dropdown',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
					default: '0',
					choices: self.CHOICES_BANKS,
				},
				{
					type: 'checkbox',
					label: 'Unlatch?',
					id: 'unlatch',
					default: false,
				},
			],
		},

		panic: {
			label: 'Abort all delayed actions',
		},

		app_exit: {
			label: 'Kill companion',
		},
		custom_variable_set_value: {
			label: 'Set custom variable value',
			options: [
				{
					type: 'dropdown',
					label: 'Custom variable',
					id: 'name',
					default: Object.keys(self.custom_variables)[0],
					choices: Object.entries(self.custom_variables).map(([id, info]) => ({
						id: id,
						label: id,
					})),
				},
				{
					type: 'textinput',
					label: 'Value',
					id: 'value',
					default: '',
				},
			],
		},
		custom_variable_set_expression: {
			label: 'Set custom variable expression',
			options: [
				{
					type: 'dropdown',
					label: 'Custom variable',
					id: 'name',
					default: Object.keys(self.custom_variables)[0],
					choices: Object.entries(self.custom_variables).map(([id, info]) => ({
						id: id,
						label: id,
					})),
				},
				{
					type: 'textwithvariables',
					label: 'Expression',
					id: 'expression',
					default: '',
				},
			],
		},
		custom_variable_store_variable: {
			label: 'Store variable value to custom variable',
			options: [
				{
					type: 'dropdown',
					label: 'Custom variable',
					id: 'name',
					default: Object.keys(self.custom_variables)[0],
					choices: Object.entries(self.custom_variables).map(([id, info]) => ({
						id: id,
						label: id,
					})),
				},
				{
					type: 'dropdown',
					id: 'variable',
					label: 'Variable to store value from',
					tooltip: 'What variable to store in the custom variable?',
					default: 'internal:time_hms',
					choices: self.CHOICES_VARIABLES,
				},
			],
		},
	}

	if (self.system.listenerCount('restart') > 0) {
		// Only offer app_restart if there is a handler for the event
		actions['app_restart'] = {
			label: 'Restart companion',
		}
	}

	self.system.emit('instance_actions', self.id, actions)
}

instance.prototype.action = function (action, extras) {
	var self = this
	var id = action.action
	var opt = action.options
	var thePage = opt.page
	var theBank = opt.bank
	var theController = opt.controller

	if (extras) {
		if (self.BUTTON_ACTIONS.includes(id)) {
			if (0 == opt.bank) {
				// 'this' button
				//			thePage = extras.page;
				theBank = extras.bank
			}
			if (0 == opt.page) {
				// 'this' page
				thePage = extras.page
			}
		} else if (self.PAGE_ACTIONS.includes(id)) {
			if (0 == opt.page) {
				// 'this' page
				thePage = extras.page
			}
		}

		if (theController == 'self') {
			theController = extras.deviceid
		}
	}

	// get userconfig object
	self.system.emit('get_userconfig', function (userconfig) {
		self.userconfig = userconfig
	})

	if (id == 'custom_variable_set_value') {
		self.system.emit('custom_variable_set_value', opt.name, opt.value)
	} else if (id === 'custom_variable_set_expression') {
		self.system.emit('custom_variable_set_expression', opt.name, opt.expression)
	} else if (id == 'custom_variable_store_variable') {
		let value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (value = v))
		self.system.emit('custom_variable_set_value', opt.name, value)
	} else if (id == 'instance_control') {
		self.system.emit('instance_enable', opt.instance_id, opt.enable == 'true')
	} else if (id == 'set_page') {
		self.changeControllerPage(theController, thePage)
	} else if (id == 'set_brightness') {
		self.system.emit('device_brightness_set', theController, opt.brightness)
	} else if (id == 'set_page_byindex') {
		if (opt.controller < self.devices.length) {
			var surface = self.devices[opt.controller].serialnumber
			self.changeControllerPage(surface, thePage)
		} else {
			self.log(
				'warn',
				'Trying to set controller #' +
					opt.controller +
					' but only ' +
					self.devices.length +
					' controller(s) are available.'
			)
		}
	} else if (id == 'inc_page') {
		let fromPage = undefined
		self.system.emit('device_page_get', theController, function (page) {
			fromPage = page
		})

		let toPage = parseInt(fromPage) + 1
		if (toPage > 99) toPage = 1

		self.changeControllerPage(theController, toPage, fromPage)
	} else if (id == 'dec_page') {
		let fromPage = undefined
		self.system.emit('device_page_get', theController, function (page) {
			fromPage = page
		})

		let toPage = parseInt(fromPage) - 1
		if (toPage < 1) toPage = 99

		self.changeControllerPage(theController, toPage, fromPage)
	} else if (id == 'lockout_device') {
		if (self.userconfig.pin_enable) {
			// Change page after this runloop
			if (extras) {
				self.system.emit('bank_pressed', extras.page, extras.bank, false, theController)
			}
			setImmediate(function () {
				if (self.userconfig.link_lockouts) {
					self.system.emit('lockoutall')
				} else {
					self.system.emit('lockout_device', theController, opt.page)
				}
			})
		}
	} else if (id == 'unlockout_device') {
		if (self.userconfig.pin_enable) {
			// Change page after this runloop
			if (extras) {
				self.system.emit('bank_pressed', extras.page, extras.bank, false, theController)
			}
			setImmediate(function () {
				if (self.userconfig.link_lockouts) {
					self.system.emit('unlockoutall')
				} else {
					self.system.emit('unlockout_device', theController, opt.page)
				}
			})
		}
	} else if (id == 'lockout_all') {
		if (self.userconfig.pin_enable) {
			if (extras) {
				self.system.emit('bank_pressed', extras.page, extras.bank, false, surface)
			}
			setImmediate(function () {
				self.system.emit('lockoutall')
			})
		}
	} else if (id == 'unlockout_all') {
		if (self.userconfig.pin_enable) {
			if (extras) {
				self.system.emit('bank_pressed', extras.page, extras.bank, false, surface)
			}
			setImmediate(function () {
				self.system.emit('unlockoutall')
			})
		}
	} else if (id == 'panic') {
		self.system.emit('action_delayed_abort')
	} else if (id == 'panic_bank') {
		self.system.emit('action_abort_bank', thePage, theBank, opt.unlatch)
	} else if (id == 'rescan') {
		self.system.emit('devices_reenumerate')
	} else if (id == 'bgcolor') {
		self.system.emit('bank_changefield', thePage, theBank, 'bgcolor', opt.color)
	} else if (id == 'textcolor') {
		self.system.emit('bank_changefield', thePage, theBank, 'color', opt.color)
	} else if (id == 'button_text') {
		self.system.emit('bank_changefield', thePage, theBank, 'text', opt.label)
	} else if (id == 'button_pressrelease') {
		self.system.emit('bank_pressed', thePage, theBank, true, theController)
		self.system.emit('bank_pressed', thePage, theBank, false, theController)
	} else if (id == 'button_press') {
		self.system.emit('bank_pressed', thePage, theBank, true, theController)
	} else if (id == 'button_release') {
		self.system.emit('bank_pressed', thePage, theBank, false, theController)
	} else if (id == 'exec') {
		if (opt.path !== undefined) {
			let path = opt.path
			self.parseVariables(path, function (value) {
				path = value;
			});
			debug("Running path: '" + path + "'")
			exec(
				path,
				{
					timeout: opt.timeout === undefined ? 5000 : opt.timeout,
				},
				function (error, stdout, stderr) {
					if (error) {
						log('error', 'Shell command failed. Guru meditation: ' + JSON.stringify(error))
						debug(error)
					}
				}
			)
		}
	} else if (id == 'app_exit') {
		self.system.emit('exit')
	} else if (id == 'app_restart') {
		self.system.emit('restart')
	}
}

instance.prototype.changeControllerPage = function (surface, page, from) {
	var self = this

	if (from === undefined) {
		self.system.emit('device_page_get', surface, function (page) {
			from = page
		})
	}

	// no history yet
	// start with the current (from) page
	if (!self.pageHistory[surface]) {
		self.pageHistory[surface] = {
			history: [from],
			index: 0,
		}
	}

	// determine the 'to' page
	if (page === 'back' || page === 'forward') {
		const pageDirection = page === 'back' ? -1 : 1
		const pageIndex = self.pageHistory[surface].index + pageDirection
		const pageTarget = self.pageHistory[surface].history[pageIndex]

		// change only if pageIndex points to a real page
		if (pageTarget !== undefined) {
			setImmediate(function () {
				self.system.emit('device_page_set', surface, pageTarget)
			})

			self.pageHistory[surface].index = pageIndex
		}
	} else {
		// Change page after this runloop
		setImmediate(function () {
			self.system.emit('device_page_set', surface, page)
		})

		// Clear forward page history beyond current index, add new history entry, increment index;
		self.pageHistory[surface].history = self.pageHistory[surface].history.slice(0, self.pageHistory[surface].index + 1)
		self.pageHistory[surface].history.push(page)
		self.pageHistory[surface].index += 1

		// Limit the max history
		const maxPageHistory = 100
		if (self.pageHistory[surface].history.length > maxPageHistory) {
			const startIndex = self.pageHistory[surface].history.length - maxPageHistory
			const endIndex = self.pageHistory[surface].history.length
			self.pageHistory[surface].history = self.pageHistory[surface].history.slice(startIndex, endIndex)
		}
	}

	return
}

function getNetworkInterfaces() {
	var self = this
	var interfaces = []
	const networkInterfaces = os.networkInterfaces()

	for (const interface in networkInterfaces) {
		let numberOfAddresses = networkInterfaces[interface].length
		let v4Addresses = []
		let iface = interface.split(' ')[0]

		for (let i = 0; i < numberOfAddresses; i++) {
			if (networkInterfaces[interface][i]['family'] === 'IPv4') {
				v4Addresses.push(networkInterfaces[interface][i].address)
			}
		}
		numV4s = v4Addresses.length
		for (let i = 0; i < numV4s; i++) {
			let aNum = numV4s > 1 ? `:${i}` : ''
			interfaces.push({
				label: `${interface}${aNum}`,
				name: `${iface}${aNum}`,
				address: v4Addresses[i],
			})
		}
	}
	self.adapters = interfaces

	return interfaces
}

instance.prototype.update_variables = function () {
	var self = this
	var variables = []
	var adapters = self.adapters

	if (adapters == undefined) {
		adapters = getNetworkInterfaces.apply(self)
	}

	for (let i in adapters) {
		variables.push({
			label: `${adapters[i].label} IP Address`,
			name: adapters[i].name,
		})
	}

	variables.push({
		label: 'Time of day (HH:MM:SS)',
		name: 'time_hms',
	})
	variables.push({
		label: 'Time of day (HH:MM)',
		name: 'time_hm',
	})
	variables.push({
		label: 'Time of day (HH)',
		name: 'time_h',
	})
	variables.push({
		label: 'Time of day (MM)',
		name: 'time_m',
	})
	variables.push({
		label: 'Time of day (SS)',
		name: 'time_s',
	})

	variables.push({
		label: 'Instances with errors',
		name: 'instance_errors',
	})
	variables.push({
		label: 'Instances with warnings',
		name: 'instance_warns',
	})
	variables.push({
		label: 'Instances OK',
		name: 'instance_oks',
	})

	variables.push({
		label: 'IP of attached network interface',
		name: 'bind_ip',
	})

	variables.push({
		label: 'IP of all network interfaces',
		name: 'all_ip',
	})

	variables.push({
		label: 'T-bar position',
		name: 't-bar',
	})

	variables.push({
		label: 'Shuttle position',
		name: 'shuttle',
	})

	variables.push({
		label: 'Jog position',
		name: 'jog',
	})

	for (const [name, info] of Object.entries(self.custom_variables)) {
		variables.push({
			label: info.description,
			name: `custom_${name}`,
		})
	}

	self.setVariableDefinitions(variables)

	self.setVariables({
		instance_errors: 0,
		instance_warns: 0,
		instance_oks: 0,
		time_hms: '',
		time_hm: '',
		time_h: '',
		time_m: '',
		time_s: '',
		't-bar': '0',
		jog: '0',
		shuttle: '0',
	})
}

instance.prototype.init_feedback = function () {
	var self = this

	var feedbacks = {}
	var instance_choices = []

	Object.entries(self.instances).forEach((entry) => {
		const [key, value] = entry
		if (value.label == 'internal') {
			instance_choices.push({ id: 'all', label: 'All Instances' })
		} else {
			instance_choices.push({ id: key, label: value.label })
		}
	})

	feedbacks['instance_status'] = {
		label: 'Companion Instance Status',
		description: 'Change button color on Instance Status\nDisabled color is not used when "All" instances is selected',
		options: [
			{
				type: 'dropdown',
				label: 'Instance or All',
				id: 'instance_id',
				choices: instance_choices,
				default: 'all',
			},
			{
				type: 'colorpicker',
				label: 'OK foreground color',
				id: 'ok_fg',
				default: self.rgb(255, 255, 255),
			},
			{
				type: 'colorpicker',
				label: 'OK background color',
				id: 'ok_bg',
				default: self.rgb(0, 200, 0),
			},
			{
				type: 'colorpicker',
				label: 'Warning foreground color',
				id: 'warning_fg',
				default: self.rgb(0, 0, 0),
			},
			{
				type: 'colorpicker',
				label: 'Warning background color',
				id: 'warning_bg',
				default: self.rgb(255, 255, 0),
			},
			{
				type: 'colorpicker',
				label: 'Error foreground color',
				id: 'error_fg',
				default: self.rgb(255, 255, 255),
			},
			{
				type: 'colorpicker',
				label: 'Error background color',
				id: 'error_bg',
				default: self.rgb(200, 0, 0),
			},
			{
				type: 'colorpicker',
				label: 'Disabled foreground color',
				id: 'disabled_fg',
				default: self.rgb(153, 153, 153),
			},
			{
				type: 'colorpicker',
				label: 'Disabled background color',
				id: 'disabled_bg',
				default: self.rgb(64, 64, 64),
			},
		],
	}
	feedbacks['bank_style'] = {
		label: 'Use another buttons color',
		description: 'Imitate the colors of another button',
		options: [
			{
				type: 'dropdown',
				label: 'Page',
				tooltip: 'What page is the button on?',
				id: 'page',
				default: '0',
				choices: self.CHOICES_PAGES,
			},
			{
				type: 'dropdown',
				label: 'Bank',
				tooltip: 'Which Button?',
				id: 'bank',
				default: '0',
				choices: self.CHOICES_BANKS,
			},
		],
	}
	feedbacks['bank_pushed'] = {
		type: 'boolean',
		label: 'When button is pushed/latched',
		description: 'Change style when a button is being pressed or is latched',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(255, 0, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Page',
				tooltip: 'What page is the button on?',
				id: 'page',
				default: '0',
				choices: self.CHOICES_PAGES,
			},
			{
				type: 'dropdown',
				label: 'Bank',
				tooltip: 'Which Button?',
				id: 'bank',
				default: '0',
				choices: self.CHOICES_BANKS,
			},
		],
	}
	feedbacks['variable_value'] = {
		type: 'boolean',
		label: 'Check variable value',
		description: 'Change style based on the value of a variable',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(255, 0, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Variable',
				tooltip: 'What variable to act on?',
				id: 'variable',
				default: 'internal:time_hms',
				choices: self.CHOICES_VARIABLES,
			},
			{
				type: 'dropdown',
				label: 'Operation',
				id: 'op',
				default: 'eq',
				choices: [
					{ id: 'eq', label: '=' },
					{ id: 'ne', label: '!=' },
					{ id: 'gt', label: '>' },
					{ id: 'lt', label: '<' },
				],
			},
			{
				type: 'textinput',
				label: 'Value',
				id: 'value',
				default: '',
			},
		],
		subscribe: (fb) => {
			if (fb.options.variable) {
				self.feedback_variable_subscriptions[fb.id] = [fb.options.variable]
			}
		},
		unsubscribe: (fb) => {
			delete self.feedback_variable_subscriptions[fb.id]
		},
	}
	feedbacks['variable_variable'] = {
		type: 'boolean',
		label: 'Compare variable to variable',
		description: 'Change style based on a variable compared to another variable',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(255, 0, 0),
		},
		options: [
			{
				type: 'dropdown',
				label: 'Compare Variable',
				tooltip: 'What variable to act on?',
				id: 'variable',
				default: 'internal:time_hms',
				choices: self.CHOICES_VARIABLES,
			},
			{
				type: 'dropdown',
				label: 'Operation',
				id: 'op',
				default: 'eq',
				choices: [
					{ id: 'eq', label: '=' },
					{ id: 'ne', label: '!=' },
					{ id: 'gt', label: '>' },
					{ id: 'lt', label: '<' },
				],
			},
			{
				type: 'dropdown',
				label: 'Against Variable',
				tooltip: 'What variable to compare with?',
				id: 'variable2',
				default: 'internal:time_hms',
				choices: self.CHOICES_VARIABLES,
			},
		],
		subscribe: (fb) => {
			if (fb.options.variable || fb.options.variable2) {
				self.feedback_variable_subscriptions[fb.id] = [fb.options.variable, fb.options.variable2]
			}
		},
		unsubscribe: (fb) => {
			delete self.feedback_variable_subscriptions[fb.id]
		},
	}

	self.setFeedbackDefinitions(feedbacks)
}

function compareValues(op, value, value2) {
	switch (op) {
		case 'gt':
			return value > parseFloat(value2)
		case 'lt':
			return value < parseFloat(value2)
		case 'ne':
			return value2 + '' != value + ''
		default:
			return value2 + '' == value + ''
	}
}

instance.prototype.feedback = function (feedback, bank, info) {
	var self = this

	if (feedback.type == 'bank_style') {
		var b = self.bank_info[`${feedback.options.page}_${feedback.options.bank}`]
		if (b !== undefined) {
			return {
				color: b.color,
				bgcolor: b.bgcolor,
			}
		}
	} else if (feedback.type == 'bank_pushed') {
		let thePage = feedback.options.page
		let theBank = feedback.options.bank

		if (info && thePage == '0') thePage = info.page
		if (info && theBank == '0') theBank = info.bank

		let isPushed = false
		self.system.emit('graphics_is_pushed', thePage, theBank, function (pushed) {
			isPushed = pushed
		})

		return isPushed
	} else if (feedback.type == 'variable_value') {
		let value = ''
		const id = feedback.options.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (value = v))

		return compareValues(feedback.options.op, value, feedback.options.value)
	} else if (feedback.type == 'variable_variable') {
		let value = ''
		let value2 = ''
		const id = feedback.options.variable.split(':')
		const id2 = feedback.options.variable2.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (value = v))
		self.system.emit('variable_get', id2[0], id2[1], (v) => (value2 = v))

		return compareValues(feedback.options.op, value, value2)
	} else if (feedback.type == 'instance_status') {
		if (feedback.options.instance_id == 'all') {
			if (self.instance_errors > 0) {
				return {
					color: feedback.options.error_fg,
					bgcolor: feedback.options.error_bg,
				}
			}

			if (self.instance_warns > 0) {
				return {
					color: feedback.options.warning_fg,
					bgcolor: feedback.options.warning_bg,
				}
			}

			return {
				color: feedback.options.ok_fg,
				bgcolor: feedback.options.ok_bg,
			}
		}

		if (self.instance_status.hasOwnProperty(feedback.options.instance_id)) {
			var cur_instance = self.instance_status[feedback.options.instance_id]

			if (cur_instance[0] == 2) {
				return {
					color: feedback.options.error_fg,
					bgcolor: feedback.options.error_bg,
				}
			}

			if (cur_instance[0] == 1) {
				return {
					color: feedback.options.warning_fg,
					bgcolor: feedback.options.warning_bg,
				}
			}

			if (cur_instance[0] == 0) {
				return {
					color: feedback.options.ok_fg,
					bgcolor: feedback.options.ok_bg,
				}
			}

			if (cur_instance[0] == -1 || cur_instance[0] == null) {
				return {
					color: feedback.options.disabled_fg,
					bgcolor: feedback.options.disabled_bg,
				}
			}
		}
		// disabled has no 'status' entry
		if (feedback.options.instance_id != 'bitfocus-companion') {
			return {
				color: feedback.options.disabled_fg,
				bgcolor: feedback.options.disabled_bg,
			}
		}
	}
}

instance_skel.extendedBy(instance)
exports = module.exports = instance
