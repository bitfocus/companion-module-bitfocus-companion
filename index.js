const instance_skel = require('../../instance_skel')
const os = require('os')
const exec = require('child_process').exec
const GetUpgradeScripts = require('./upgrades')
const _ = require('underscore')
const jp = require('jsonpath')

function instance(system, id, config) {
	let self = this

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
	let self = this

	self.callbacks = {}
	self.instances = {}
	self.active = {}
	self.cached_bank_info = {}
	self.pageHistory = {}
	self.custom_variables = {}
	self.triggers = []

	self.feedback_variable_subscriptions = {}

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

	self.devices_getall()
	self.addSystemCallback('devices_list', self.devices_list.bind(self))

	self.bind_ip_get()
	self.addSystemCallback('ip_rebind', self.bind_ip_get.bind(self))

	self.banks_getall()
	self.addSystemCallback('graphics_bank_invalidate', self.bank_invalidate.bind(self))

	self.addSystemCallback('graphics_indicate_push', self.bank_indicate_push.bind(self))

	self.instance_save()
	self.addSystemCallback('instance_save', self.instance_save.bind(self))

	self.addSystemCallback('variables_changed', self.variables_changed.bind(self))

	self.addSystemCallback('custom_variables_update', self.custom_variable_list_update.bind(self))
	self.custom_variable_list_update()

	self.addSystemCallback('schedule_refresh', self.triggers_update.bind(self))
	self.triggers_update()

	self.init_feedback() // Done by self.triggers_update()
	self.init_actions() // Done by self.triggers_update()
	// self.update_variables() // Done by self.custom_variable_list_update()

	self.checkFeedbacks()

	self.subscribeFeedbacks('variable_value')
	self.subscribeFeedbacks('variable_variable')

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

	self.status(self.STATE_OK)
}

instance.prototype.bind_ip_get = function () {
	let self = this
	let adapters = getNetworkInterfaces.apply(self)
	let ip = ''

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

instance.prototype.banks_getall = function () {
	let self = this

	self.system.emit('db_get', 'bank', function (banks) {
		self.raw_banks = banks

		const new_values = {}

		for (let p in banks) {
			for (let b in banks[p]) {
				let tb = banks[p][b]
				let cacheKey = `${p}_${b}`
				let variableId = `b_text_${cacheKey}`
				if (tb.style === 'png') {
					// need a copy, not a reference
					self.cached_bank_info[cacheKey] = JSON.parse(JSON.stringify(tb))
					new_values[variableId] = self.cached_bank_info[cacheKey].text = self.check_var_recursion(variableId, tb.text)
				} else {
					new_values[variableId] = undefined
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
}

instance.prototype.triggers_update = function (data) {
	const self = this

	if (data) {
		self.triggers = data
	} else {
		self.system.emit('schedule_get', (d) => {
			self.triggers = d
		})
	}

	self.checkFeedbacks('trigger_enabled')
}

instance.prototype.check_var_recursion = function (v, realText) {
	let self = this
	let newText

	if (realText) {
		if (realText.includes(v)) {
			// recursion error:
			// button trying to include itself
			newText = '$RE'
		} else {
			self.system.emit('variable_parse', realText, function (str) {
				newText = str
			})
		}
	}
	return newText
}

instance.prototype.bank_invalidate = function (page, bank) {
	let self = this
	const cacheId = `${page}_${bank}`
	const variableId = `b_text_${cacheId}`

	if (!self.cached_bank_info[cacheId]) {
		// new key
		self.cached_bank_info[cacheId] = JSON.parse(JSON.stringify(self.raw_banks[page][bank]))
	}

	const oldText = self.cached_bank_info[cacheId].text

	// Fetch feedback-overrides for bank
	self.system.emit('feedback_get_style', page, bank, function (style) {
		// ffigure out the new combined style
		const newStyle = {
			...JSON.parse(JSON.stringify(self.raw_banks[page][bank])),
			...style,
		}

		// check if there was a change
		if (!_.isEqual(newStyle, self.cached_bank_info[cacheId])) {
			self.cached_bank_info[cacheId] = newStyle
			self.checkFeedbacks('bank_style')
		}
	})

	// Check if the text has changed
	const newText = self.check_var_recursion(variableId, self.cached_bank_info[cacheId].text)
	self.cached_bank_info[cacheId].text = newText
	if (oldText !== newText) {
		self.setVariable(variableId, newText)
	}
}

instance.prototype.bank_indicate_push = function (page, bank, state) {
	let self = this

	self.checkFeedbacks('bank_pushed')
}

instance.prototype.devices_list = function (list) {
	let self = this

	self.devices = list
}

instance.prototype.devices_getall = function () {
	let self = this

	self.system.emit('devices_list_get', function (list) {
		self.devices = list
	})
}

instance.prototype.variables_changed = function (changed_variables, removed_variables) {
	let self = this

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
	let self = this

	self.system.emit('instance_getall', self.instance_getall.bind(self))
}

instance.prototype.instance_getall = function (instances, active) {
	let self = this
	self.instances = instances
	self.active = active
}

instance.prototype.addSystemCallback = function (name, cb) {
	let self = this

	if (self.callbacks[name] === undefined) {
		self.callbacks[name] = cb.bind(self)
		self.system.on(name, cb)
	}
}

instance.prototype.removeAllSystemCallbacks = function () {
	let self = this

	for (let key in self.callbacks) {
		self.system.removeListener(key, self.callbacks[key])
		delete self.callbacks[key]
	}
}

instance.prototype.updateConfig = function (config) {
	let self = this
	self.config = config
}

// Return config fields for web config
instance.prototype.config_fields = function () {
	let self = this

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
	let self = this
	if (self.time_interval) {
		clearInterval(self.time_interval)
	}
	self.removeAllSystemCallbacks()
}

instance.prototype.init_actions = function (system) {
	let self = this

	actions = {
		instance_control: {
			label: 'Enable or disable connection',
			options: [
				{
					type: 'internal:instance_id',
					label: 'Connection',
					id: 'instance_id',
				},
				{
					type: 'dropdown',
					label: 'Enable',
					id: 'enable',
					default: 'true',
					// choices: self.CHOICES_YESNO_BOOLEAN, // original
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'true', label: 'Yes' },
						{ id: 'false', label: 'No' },
					],
				},
			],
		},
		set_page: {
			label: 'Set surface with s/n to page',
			options: [
				{
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
				},
				{
					type: 'internal:page',
					label: 'Page',
					id: 'page',
					includeDirection: true,
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
					type: 'internal:page',
					label: 'Page',
					id: 'page',
					includeDirection: true,
				},
			],
		},
		set_brightness: {
			label: 'Set surface with s/n brightness',
			options: [
				{
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
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
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
				},
			],
		},
		unlockout_device: {
			label: 'Trigger a device to unlock immediately.',
			options: [
				{
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
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
				{
					type: 'internal:custom_variable',
					label: 'Target Variable (stdout)',
					id: 'targetVariable',
					includeNone: true,
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
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
				},
			],
		},
		dec_page: {
			label: 'Decrement page number',
			options: [
				{
					type: 'internal:surface_serial',
					label: 'Surface / controller',
					id: 'controller',
				},
			],
		},

		button_pressrelease: {
			label: 'Button press and release',
			options: [
				{
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which button?',
					id: 'bank',
				},
			],
		},

		button_pressrelease_condition: {
			label: 'Button Press/Release if Variable meets Condition',
			options: [
				{
					type: 'internal:variable',
					id: 'variable',
					label: 'Variable to check',
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
					type: 'textwithvariables',
					label: 'Value',
					id: 'value',
					default: '',
				},
				{
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which button?',
					id: 'bank',
				},
			],
		},

		button_pressrelease_condition_variable: {
			label: 'Button Press/Release if Variable meets Condition (Custom Variables)',
			options: [
				{
					type: 'internal:variable',
					id: 'variable',
					label: 'Variable to check',
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
					type: 'textwithvariables',
					label: 'Value',
					id: 'value',
					default: '',
				},
				{
					type: 'internal:custom_variable',
					label: 'Page by Custom Variable',
					id: 'page',
				},
				{
					type: 'internal:custom_variable',
					label: 'Bank by Custom Variable',
					id: 'bank',
				},
			],
		},

		button_press: {
			label: 'Button Press',
			options: [
				{
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
				},
			],
		},

		button_release: {
			label: 'Button Release',
			options: [
				{
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
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
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
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
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
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
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
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
					type: 'internal:page',
					label: 'Page',
					tooltip: 'What page is the button on?',
					id: 'page',
				},
				{
					type: 'internal:bank',
					label: 'Bank',
					tooltip: 'Which Button?',
					id: 'bank',
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
					type: 'internal:custom_variable',
					label: 'Custom variable',
					id: 'name',
				},
				{
					type: 'textinput',
					label: 'Value',
					id: 'value',
					default: '',
				},
			],
		},
		custom_variable_math_operation: {
			label: 'Modify Variable Value with Math Operation',
			options: [
				{
					type: 'internal:variable',
					label: 'Variable',
					id: 'variable',
				},
				{
					type: 'dropdown',
					label: 'Operation',
					id: 'operation',
					default: 'plus',
					choices: [
						{ id: 'plus', label: 'Variable Plus Value' },
						{ id: 'minus', label: 'Variable Minus Value' },
						{ id: 'minus_opposite', label: 'Value Minus Variable' },
						{ id: 'multiply', label: 'Variable Multiplied By Value' },
						{ id: 'divide', label: 'Variable Divided By Value' },
						{ id: 'divide_opposite', label: 'Value Divided By Variable' },
					],
				},
				{
					type: 'textwithvariables',
					label: 'Value',
					id: 'value',
					default: '',
				},
				{
					type: 'internal:custom_variable',
					label: 'Resulting Variable',
					id: 'result',
				},
			],
		},
		custom_variable_math_int_operation: {
			label: 'Modify Variable Value with Math Convert To Int Operation',
			options: [
				{
					type: 'internal:variable',
					label: 'Variable',
					id: 'variable',
				},
				{
					type: 'number',
					label: 'Radix',
					id: 'radix',
					default: 10,
					min: 2,
					max: 36,
					step: 1,
					range: true,
				},
				{
					type: 'internal:custom_variable',
					label: 'Resulting Variable',
					id: 'result',
				},
			],
		},
		custom_variable_string_trim_operation: {
			label: 'Modify Variable Value with String Trim Operation',
			options: [
				{
					type: 'internal:variable',
					label: 'Variable',
					id: 'variable',
				},
				{
					type: 'internal:custom_variable',
					label: 'Resulting Variable',
					id: 'result',
				},
			],
		},
		custom_variable_string_concat_operation: {
			label: 'Modify Variable Value with String Concatenation Operation',
			options: [
				{
					type: 'internal:variable',
					label: 'Variable',
					id: 'variable',
				},
				{
					type: 'textwithvariables',
					label: 'Combine with Value',
					id: 'value',
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Order',
					id: 'order',
					default: 'variable_value',
					choices: [
						{ id: 'variable_value', label: 'Variable + Value' },
						{ id: 'value_variable', label: 'Value + Variable' },
					],
				},
				{
					type: 'internal:custom_variable',
					label: 'Resulting Variable',
					id: 'result',
				},
			],
		},
		custom_variable_string_substring_operation: {
			label: 'Modify Variable Value with String Substring Operation',
			options: [
				{
					type: 'internal:variable',
					label: 'Variable',
					id: 'variable',
				},
				{
					type: 'textwithvariables',
					label: 'Start of Substring',
					id: 'start',
					default: '',
				},
				{
					type: 'textwithvariables',
					label: 'End of Substring',
					id: 'end',
					default: '',
				},
				{
					type: 'internal:custom_variable',
					label: 'Resulting Variable',
					id: 'result',
				},
			],
		},
		custom_variable_set_expression: {
			label: 'Set custom variable expression',
			options: [
				{
					type: 'internal:custom_variable',
					label: 'Custom variable',
					id: 'name',
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
					type: 'internal:custom_variable',
					label: 'Custom variable',
					id: 'name',
				},
				{
					type: 'internal:variable',
					id: 'variable',
					label: 'Variable to store value from',
					tooltip: 'What variable to store in the custom variable?',
				},
			],
		},
		custom_variable_set_via_jsonpath: {
			label: 'Set custom variable from a stored JSONresult via a JSONpath expression',
			options: [
				{
					type: 'internal:custom_variable',
					label: 'JSON Result Data Variable',
					id: 'jsonResultDataVariable',
				},

				{
					type: 'textwithvariables',
					label: 'Path (like $.age)',
					id: 'jsonPath',
					default: '',
				},
				{
					type: 'internal:custom_variable',
					label: 'Target Variable',
					id: 'targetVariable',
				},
			],
		},
		trigger_enabled: {
			label: 'Enable or disable trigger',
			options: [
				{
					type: 'internal:trigger',
					label: 'Trigger',
					id: 'trigger_id',
				},
				{
					type: 'dropdown',
					label: 'Enable',
					id: 'enable',
					default: 'true',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'true', label: 'Yes' },
						{ id: 'false', label: 'No' },
					],
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
	let self = this
	let id = action.action
	let opt = action.options
	let thePage = opt.page
	let theBank = opt.bank
	let theController = opt.controller

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

	// extract value from the stored json response data, assign to target variable
	if (id === 'custom_variable_set_via_jsonpath') {
		// get the json response data from the custom variable that holds the data
		let jsonResultData = ''
		let variableName = `custom_${action.options.jsonResultDataVariable}`
		self.system.emit('variable_get', 'internal', variableName, (value) => {
			jsonResultData = value
			self.debug('jsonResultData', jsonResultData)
		})

		// recreate a json object from stored json result data string
		let objJson = ''
		try {
			objJson = JSON.parse(jsonResultData)
		} catch (e) {
			self.log('error', `HTTP ${id.toUpperCase()} Cannot create JSON object, malformed JSON data (${e.message})`)
			return
		}

		// extract the value via the given standard JSONPath expression
		let valueToSet = ''
		try {
			valueToSet = jp.query(objJson, action.options.jsonPath)
		} catch (error) {
			self.log('error', `HTTP ${id.toUpperCase()} Cannot extract JSON value (${e.message})`)
			return
		}

		self.system.emit('custom_variable_set_value', action.options.targetVariable, valueToSet)

		return
	}

	if (id == 'custom_variable_set_value') {
		self.system.emit('custom_variable_set_value', opt.name, opt.value)
	} else if (id == 'custom_variable_math_operation') {
		let value = ''

		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		variable_value_number = Number(variable_value)

		let operation_value = opt.value
		self.parseVariables(operation_value, function (value) {
			operation_value = value
		})

		operation_value_number = Number(operation_value)

		switch (opt.operation) {
			case 'plus':
				value = variable_value_number + operation_value_number
				break
			case 'minus':
				value = variable_value_number - operation_value_number
				break
			case 'minus_opposite':
				value = operation_value_number - variable_value_number
				break
			case 'multiply':
				value = variable_value_number * operation_value_number
				break
			case 'divide':
				value = variable_value_number / operation_value_number
				break
			case 'divide_opposite':
				value = operation_value_number / variable_value_number
				break
		}

		self.system.emit('custom_variable_set_value', opt.result, value)
	} else if (id == 'custom_variable_math_int_operation') {
		let value = ''

		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		value = parseInt(variable_value, opt.radix)

		self.system.emit('custom_variable_set_value', opt.result, value)
	} else if (id == 'custom_variable_string_trim_operation') {
		let value = ''

		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		value = variable_value.trim()

		self.system.emit('custom_variable_set_value', opt.result, value)
	} else if (id == 'custom_variable_string_concat_operation') {
		let value = ''

		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		let operation_value = opt.value
		self.parseVariables(operation_value, function (value) {
			operation_value = value
		})

		if (opt.order == 'variable_value') {
			value = variable_value.toString() + operation_value.toString()
		} else {
			value = operation_value.toString() + variable_value.toString()
		}

		self.system.emit('custom_variable_set_value', opt.result, value)
	} else if (id == 'custom_variable_string_substring_operation') {
		let value = ''

		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		let start = opt.start
		self.parseVariables(start, function (value) {
			start = parseInt(value)
		})

		let end = opt.end
		self.parseVariables(end, function (value) {
			end = parseInt(value)
		})

		value = variable_value.substring(start, end)

		self.system.emit('custom_variable_set_value', opt.result, value)
	} else if (id === 'custom_variable_set_expression') {
		self.system.emit('custom_variable_set_expression', opt.name, opt.expression)
	} else if (id == 'custom_variable_store_variable') {
		let value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (value = v))
		self.system.emit('custom_variable_set_value', opt.name, value)
	} else if (id == 'instance_control') {
		let curState = ''
		if (self.instance_status.hasOwnProperty(opt.instance_id)) {
			curState = self.instance_status[opt.instance_id][0]
		}
		else curState = -1 // no status entry if instance is disabled
		let newState = opt.enable  == 'true'
		if (opt.enable == 'toggle') {
			if (curState == -1) newState = true
			else newState = false
		}
		self.system.emit('instance_enable', opt.instance_id, newState)
	} else if (id == 'set_page') {
		self.changeControllerPage(theController, thePage)
	} else if (id == 'set_brightness') {
		self.system.emit('device_brightness_set', theController, opt.brightness)
	} else if (id == 'set_page_byindex') {
		if (opt.controller < self.devices.length) {
			let surface = self.devices[opt.controller].serialnumber
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
	} else if (id == 'button_pressrelease_condition') {
		let variable_value = ''
		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		let condition = opt.value
		self.parseVariables(condition, function (value) {
			condition = value
		})

		let variable_value_number = Number(variable_value)
		let condition_number = Number(condition)

		let pressIt = false

		if (opt.op == 'eq') {
			if (variable_value.toString() == condition.toString()) {
				pressIt = true
			}
		} else if (opt.op == 'ne') {
			if (variable_value.toString() !== condition.toString()) {
				pressIt = true
			}
		} else if (opt.op == 'gt') {
			if (variable_value_number > condition_number) {
				pressIt = true
			}
		} else if (opt.op == 'lt') {
			if (variable_value_number < condition_number) {
				pressIt = true
			}
		}

		if (pressIt) {
			self.system.emit('bank_pressed', thePage, theBank, true, theController)
			self.system.emit('bank_pressed', thePage, theBank, false, theController)
		}
	} else if (id == 'button_pressrelease_condition_variable') {
		let variable_value = ''

		const id = opt.variable.split(':')
		self.system.emit('variable_get', id[0], id[1], (v) => (variable_value = v))

		let condition = opt.value
		self.parseVariables(condition, function (value) {
			condition = value
		})

		let variable_value_number = Number(variable_value)
		let condition_number = Number(condition)

		let pressIt = false

		if (opt.op == 'eq') {
			if (variable_value.toString() == condition.toString()) {
				pressIt = true
			}
		} else if (opt.op == 'ne') {
			if (variable_value.toString() !== condition.toString()) {
				pressIt = true
			}
		} else if (opt.op == 'gt') {
			if (variable_value_number > condition_number) {
				pressIt = true
			}
		} else if (opt.op == 'lt') {
			if (variable_value_number < condition_number) {
				pressIt = true
			}
		}

		if (pressIt) {
			const page_id = opt.page.split(':')
			self.system.emit('variable_get', page_id[0], page_id[1], (v) => (thePage = v))
			thePage = parseInt(thePage)

			const bank_id = opt.bank.split(':')
			self.system.emit('variable_get', bank_id[0], bank_id[1], (v) => (theBank = v))
			theBank = parseInt(theBank)

			self.system.emit('bank_pressed', thePage, theBank, true, theController)
			self.system.emit('bank_pressed', thePage, theBank, false, theController)
		}
	} else if (id == 'button_press') {
		self.system.emit('bank_pressed', thePage, theBank, true, theController)
	} else if (id == 'button_release') {
		self.system.emit('bank_pressed', thePage, theBank, false, theController)
	} else if (id == 'exec') {
		if (opt.path !== undefined) {
			let path = opt.path
			self.parseVariables(path, function (value) {
				path = value
			})
			self.debug("Running path: '" + path + "'")
			exec(
				path,
				{
					timeout: opt.timeout === undefined ? 5000 : opt.timeout,
				},
				function (error, stdout, stderr) {
					if (error) {
						self.log('error', 'Shell command failed. Guru meditation: ' + JSON.stringify(error))
						self.debug(error)
					}
					self.system.emit('custom_variable_set_value', action.options.targetVariable, stdout)
				}
			)
		}
	} else if (id == 'app_exit') {
		self.system.emit('exit')
	} else if (id == 'app_restart') {
		self.system.emit('restart')
	} else if (id == 'trigger_enabled') {
		const trigger = self.triggers.find((x) => x.id === opt.trigger_id)
		if (!trigger) return false

		let newState = opt.enable == 'true'
		if (opt.enable == 'toggle') newState = !!trigger.disabled

		self.system.emit('schedule_set_enabled', opt.trigger_id, newState)
	}
}

instance.prototype.changeControllerPage = function (surface, page, from) {
	let self = this

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
	let self = this
	let interfaces = []
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
	let self = this
	let variables = []
	let adapters = self.adapters

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
}

instance.prototype.init_feedback = function () {
	let self = this

	let feedbacks = {}

	feedbacks['instance_status'] = {
		label: 'Companion Connection Status',
		description:
			'Change button color on Connection Status\nDisabled color is not used when "All" connections is selected',
		options: [
			{
				type: 'internal:instance_id',
				label: 'Connection or All',
				id: 'instance_id',
				includeAll: true,
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
		label: 'Use another buttons style',
		description: 'Imitate the style of another button',
		options: [
			{
				type: 'internal:page',
				label: 'Page',
				tooltip: 'What page is the button on?',
				id: 'page',
			},
			{
				type: 'internal:bank',
				label: 'Bank',
				tooltip: 'Which Button?',
				id: 'bank',
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
				type: 'internal:page',
				label: 'Page',
				tooltip: 'What page is the button on?',
				id: 'page',
			},
			{
				type: 'internal:bank',
				label: 'Bank',
				tooltip: 'Which Button?',
				id: 'bank',
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
				type: 'internal:variable',
				label: 'Variable',
				tooltip: 'What variable to act on?',
				id: 'variable',
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
				type: 'internal:variable',
				label: 'Compare Variable',
				tooltip: 'What variable to act on?',
				id: 'variable',
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
				type: 'internal:variable',
				label: 'Against Variable',
				tooltip: 'What variable to compare with?',
				id: 'variable2',
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
	feedbacks['trigger_enabled'] = {
		type: 'boolean',
		label: 'Check if trigger is enabled or disabled',
		style: {
			color: self.rgb(255, 255, 255),
			bgcolor: self.rgb(255, 0, 0),
		},
		options: [
			{
				type: 'internal:trigger',
				label: 'Trigger',
				id: 'trigger_id',
			},
			{
				type: 'dropdown',
				label: 'Enable',
				id: 'enable',
				default: 'true',
				choices: self.CHOICES_YESNO_BOOLEAN,
			},
		],
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
	let self = this

	if (feedback.type == 'bank_style') {
		let thePage = feedback.options.page
		let theBank = feedback.options.bank

		if (info && thePage == '0') thePage = info.page
		if (info && theBank == '0') theBank = info.bank

		return self.cached_bank_info[`${thePage}_${theBank}`]
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
			let cur_instance = self.instance_status[feedback.options.instance_id]

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
	} else if (feedback.type == 'trigger_enabled') {
		const trigger = self.triggers.find((x) => x.id === feedback.options.trigger_id)
		if (!trigger) return false

		const state = !trigger.disabled
		const target = feedback.options.enable == 'true'
		return state == target
	}
}

instance_skel.extendedBy(instance)
exports = module.exports = instance
