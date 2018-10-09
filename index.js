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

	self.CHOICES_INSSTANCES = [];

	self.instance_save();
	self.addSystemCallback('instance_save', self.instance_save.bind(self));

	self.status(self.STATE_OK);
};

instance.prototype.instance_save = function() {
	var self = this;

	self.system.emit('instance_getall', self.instance_getall.bind(self));
};

instance.prototype.instance_getall = function(instances, active) {
	var self = this;
	self.instances = instances;
	self.active = active;
	self.CHOICES_INSSTANCES.length = 0;

	for (var key in self.instances) {
		self.CHOICES_INSSTANCES.push({ label: self.instances[key].label, id: key });
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

	self.system.emit('instance_actions', self.id, {
		'instance_control': {
			label: 'Enable or disable instance',
			options: [
				{
					 type: 'dropdown',
					 label: 'Instance',
					 id: 'instance_id',
					 default: self.CHOICES_INSSTANCES[0].id,
					 choices: self.CHOICES_INSSTANCES
				},
				{
					 type: 'dropdown',
					 label: 'Enable',
					 id: 'enable',
					 default: 'true',
					 choices: self.CHOICES_YESNO_BOOLEAN
				}
			]
		}
	});
};

instance.prototype.action = function(action) {
	var self = this;
	var id = action.action;
	var cmd;
	var opt = action.options;

	console.log(id, ' opts: ', opt);

	if (id == 'instance_control') {
		self.system.emit('instance_enable', opt.instance_id, opt.enable == 'true');
	}
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
