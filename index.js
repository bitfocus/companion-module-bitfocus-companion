var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	self.model = 0;
	self.states = {};

	self.inputs = {};

	// super-constructor
	instance_skel.apply(this, arguments);

	return self;
}

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.callbacks = {};
	self.instances = {};
	self.active = {};
	self.pages = {};

	self.CHOICES_INSTANCES = [];
	self.CHOICES_SURFACES = [];
	self.CHOICES_PAGES = [];

	self.pages_getall();
	self.addSystemCallback('page-update', self.pages_update.bind(self));

	self.devices_getall();
	self.addSystemCallback('devices_list', self.devices_list.bind(self));

	self.instance_save();
	self.addSystemCallback('instance_save', self.instance_save.bind(self));

	self.status(self.STATE_OK);
};

instance.prototype.pages_getall = function() {
	var self = this;

	self.system.emit('get_page', function (pages) {
		self.pages = pages;
	});
};

instance.prototype.pages_update = function() {
	var self = this;

	// Update dropdowns
	self.init_actions();
};

instance.prototype.devices_list = function(list) {
	var self = this;

	self.devices = list;
	self.init_actions();
};

instance.prototype.devices_getall = function() {
	var self = this;

	self.system.emit('devices_list_get', function (list) {
		self.devices = list;
	});
};

instance.prototype.instance_save = function() {
	var self = this;

	self.system.emit('instance_getall', self.instance_getall.bind(self));
};

instance.prototype.instance_getall = function(instances, active) {
	var self = this;
	self.instances = instances;
	self.active = active;
	self.CHOICES_INSTANCES.length = 0;

	for (var key in self.instances) {
		self.CHOICES_INSTANCES.push({ label: self.instances[key].label, id: key });
	}

	self.init_actions();
};

instance.prototype.addSystemCallback = function(name, cb) {
	var self = this;

	if (self.callbacks[name] === undefined) {
		self.callbacks[name] = cb.bind(self);
		self.system.on(name, cb);
	}
};

instance.prototype.removeAllSystemCallbacks = function () {
	var self = this;

	for (var key in self.callbacks) {
		system.removeListener(key, self.callbacks[key]);
		delete self.callbacks[key];
	}
};

instance.prototype.updateConfig = function(config) {
	var self = this;
	self.config = config;

};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module exposes internal functions of companion and does not have any configuration options'
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	self.removeAllSystemCallbacks();
};

instance.prototype.init_actions = function(system) {
	var self = this;

	self.CHOICES_SURFACES.length = 0;
	self.CHOICES_SURFACES.push({
		label: 'Current surface',
		id: 'self'
	});
	for (var i = 0; i < self.devices.length; ++i) {
		self.CHOICES_SURFACES.push({
			label: self.devices[i].type + ' (' + self.devices[i].serialnumber + ')',
			id: self.devices[i].serialnumber
		})
	}

	self.CHOICES_PAGES.length = 0;
	for (var page in self.pages) {
		var name = 'Page ' + page;

		if (self.pages[page].name !== undefined && self.pages[page].name != 'PAGE') {
			name += ' (' + self.pages[page].name + ')';
		}
		self.CHOICES_PAGES.push({
			label: name,
			id: page
		});
	}

	self.system.emit('instance_actions', self.id, {
		'instance_control': {
			label: 'Enable or disable instance',
			options: [
				{
					 type: 'dropdown',
					 label: 'Instance',
					 id: 'instance_id',
					 default: self.CHOICES_INSTANCES.length > 0 ? self.CHOICES_INSTANCES[0].id : undefined,
					 choices: self.CHOICES_INSTANCES
				},
				{
					 type: 'dropdown',
					 label: 'Enable',
					 id: 'enable',
					 default: 'true',
					 choices: self.CHOICES_YESNO_BOOLEAN
				}
			]
		},
		'set_page': {
			label: 'Set surface to page',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES
				},
				{
					type: 'dropdown',
					label: 'Page',
					id: 'page',
					default: '1',
					choices: self.CHOICES_PAGES
				}
			]
		},
		'inc_page': {
			label: 'Increment page number',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES
				}
			]
		},
		'dec_page': {
			label: 'Decrement page number',
			options: [
				{
					type: 'dropdown',
					label: 'Surface / controller',
					id: 'controller',
					default: 'self',
					choices: self.CHOICES_SURFACES
				}
			]
		},
		'panic': {
			label: 'Abort all delayed actions'
		}
	});
};

instance.prototype.action = function(action, extras) {
	var self = this;
	var id = action.action;
	var cmd;
	var opt = action.options;

	if (id == 'instance_control') {
		self.system.emit('instance_enable', opt.instance_id, opt.enable == 'true');
	}

	else if (id == 'set_page') {
		var surface = opt.controller == 'self' ? extras.deviceid : opt.controller;

		// Change page after this runloop
		setImmediate(function () {
			self.system.emit('device_set_page', surface, opt.page);
		});

		// If we change page while pushing a button, we need to tell the button that we were done with it
		// TODO: Somehow handle the futile "action_release" of the same button on the new page
		if (surface == extras.deviceid) {
			self.system.emit('bank-pressed', extras.page, extras.bank, false, surface);
		}
	}

	else if (id == 'inc_page') {
		var surface = opt.controller == 'self' ? extras.deviceid : opt.controller;

		// Change page after this runloop
		setImmediate(function () {
			self.system.emit('device_inc_page', surface);
		});

		// If we change page while pushing a button, we need to tell the button that we were done with it
		// TODO: Somehow handle the futile "action_release" of the same button on the new page
		if (surface == extras.deviceid) {
			self.system.emit('bank-pressed', extras.page, extras.bank, false, surface);
		}
	}

	else if (id == 'dec_page') {
		var surface = opt.controller == 'self' ? extras.deviceid : opt.controller;

		// Change page after this runloop
		setImmediate(function () {
			self.system.emit('device_dec_page', surface);
		});

		// If we change page while pushing a button, we need to tell the button that we were done with it
		// TODO: Somehow handle the futile "action_release" of the same button on the new page
		if (surface == extras.deviceid) {
			self.system.emit('bank-pressed', extras.page, extras.bank, false, surface);
		}
	}

	else if (id == 'panic') {
		self.system.emit('action_delayed_abort');
	}

};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
