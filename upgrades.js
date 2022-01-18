module.exports = function () {
	return [upgrade15to32, upgrade_one2bank, instance_status_colors, latch_to_stepped_pushed]
}

// Version 1 = from 15 to 32 keys config
function upgrade15to32(context, config, actions, feedbacks) {
	for (const action of actions) {
		if (action.options !== undefined && action.options.page !== undefined && action.options.bank !== undefined) {
			var bank = parseInt(action.options.bank)

			action.options.bank = context.convert15to32(bank)
		}
	}
}

// rename for consistency
function upgrade_one2bank(context, config, actions, feedbacks) {
	var changed = false

	for (const action of actions) {
		if ('panic_one' == action.action) {
			action.action = 'panic_bank'
			action.label = action.instance + ':' + action.action
			changed = true
		}
	}

	return changed
}

// v1.1.3 > v1.1.4
function instance_status_colors(context, config, actions, feedbacks) {
	let changed = false

	for (let fb in feedbacks) {
		if (fb.type == 'instance_status') {
			if (fb.options.instance_id === undefined) {
				fb.options.instance_id = 'all'
				changed = true
			}
			if (fb.options.ok_fg === undefined) {
				fb.options.ok_fg = self.rgb(255, 255, 255)
				changed = true
			}
			if (fb.options.ok_bg === undefined) {
				fb.options.ok_bg = self.rgb(0, 200, 0)
				changed = true
			}
			if (fb.options.warning_fg === undefined) {
				fb.options.warning_fg = self.rgb(0, 0, 0)
				changed = true
			}
			if (fb.options.warning_bg === undefined) {
				fb.options.warning_bg = self.rgb(255, 255, 0)
				changed = true
			}
			if (fb.options.error_fg === undefined) {
				fb.options.error_fg = self.rgb(255, 255, 255)
				changed = true
			}
			if (fb.options.error_bg === undefined) {
				fb.options.error_bg = self.rgb(200, 0, 0)
				changed = true
			}
		}
	}

	return changed
}

// stepped buttons
function latch_to_stepped_pushed(context, config, actions, feedbacks) {
	let changed = false

	for (const feedback of feedbacks) {
		if (feedback.type == 'bank_pushed') {
			feedback.options.latch_compatability = true
		}
	}

	return changed
}
