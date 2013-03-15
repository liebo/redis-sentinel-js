var EventEmitter = require('events').EventEmitter;
var net = require("net");

var MasterClient = require("./master_client.js");
var redis = require("redis");
var _ = require("underscore");

module.exports = Monitor;

/**
 *  The abstract client to the sentinel cluster.  Monitors sentinels
 *  in order to preserve the state of the redis cluster accoss individual
 *  redis clients.
 *
 *  @param {Object} options
 *      A dictionary of the options determining the settings for the redis cluster
 *      options.ports => an array of port numbers indicating how to connect to sentinels
 *      options.host => a string indicating the host to connect to
 *      options.timeout => the timeout for queued requests wating for failover to finish
 */
function Monitor( options ) {

    var self = this;
    EventEmitter.call(this);

    var defaults = {
        host: 'localhost',
        ports: [23679],
        failover_timeout: 5000
    }
    var settings = {};
    _.extend(settings, defaults, options);
    this.options = settings;

    this.master_clients = {};
    this.sentinel_clients = [];
    this.masters = {};
    this.slaves = {};

    this.current_sentinel = null;
    this.current_subscription = null;

    this.clusters_expected = 0;
    this.clusters_loaded = 0;

    this.sync = function() {
        this.clusters_expected = 0;
        this.clusters_loaded = 0;
        this.select_current_sentinel();
    }

    ////////////////////////////////

    this.SUBSCRIPTION_HANDLES = {
        '+sdown': on_sub_down,
        '-sdown': on_sub_up,
        '+odown': on_obj_down,
        '-odown': on_obj_up,
        '+sentinel': on_new_sentinel,
        '+slave': on_new_slave,
        '+switch-master': on_switch_master,
        '+reboot': on_reboot_instance
    }

    this.add_sentinel = add_sentinel;
    for (var port_index in settings.ports) {
        this.add_sentinel(settings.ports[port_index], settings.host, true);
    }

    function on_obj_down(info) {
        if (info.type == 'master') self.get_client(info.name).enter_failsafe_state();
        else {
            // TODO: handle sentinels and slaves--nothing to do here yet
        }
    }

    function on_obj_up(info) {
        if (info.type == 'master') self.get_client(info.name).exit_failsafe_state();
        else {
            // TODO: handle sentinels and slaves--nothing to do here yet
        }
    }

    // change these for different behavior on +-subdown
    function on_sub_down(info) {
        on_obj_down(info);
    }
    function on_sub_up(info) {
        on_obj_up(info);
    }

    function on_new_slave(info) {
        load_slave_list(info.master_name);
    }

    function on_new_sentinel(info) {
        add_sentinel(info.port, info.host);
    }

    // does nothing.  Should be handled by subdown/odown.
    function on_reboot_instance(info) {
        console.log(info.type + ' just rebooted');
    }

    function add_sentinel(port, host, skip_check_if_exists) {
        if (skip_check_if_exists || !does_sentinel_exist(host, port)) {
            self.sentinel_clients.push(redis.createClient(port, host));
        }
    }

    function on_switch_master(){}

    function does_sentinel_exist (host, port) {
        return _.any(self.sentinel_clients, function(sentinel) {
            return sentinel.host === host && sentinel.port === port;
        });
    }


    //**** EVENTS ****//
    this.on('sentinel_selected', this.load_master_list);
    this.on('master_config_loaded', this.load_slave_list);
    this.on('cluster_ready', cluster_config_loaded);

    function cluster_config_loaded() {
        self.clusters_loaded++;
        if (self.clusters_loaded == self.clusters_expected) self.sync_complete();
    }
    

}

Monitor.prototype.__proto__ = EventEmitter.prototype;

Monitor.prototype.get_client = function(master_name) {
    var mc = this.master_clients[master_name];

    if (mc) return mc;

    // TODO: handle lack of master going by this name
    var config = this.masters[master_name];
    if (!config) throw "Sentinels cannot find master: " + master_name;

    var port = parseInt(config.port);
    var host = config.ip;
    var slaves = this.slaves[master_name];
    var timeout = this.failover_timeout;
    var mc = this.create_master_client(master_name, port, host, slaves, timeout);
    this.master_clients[master_name] = mc;
    return mc;
}
Monitor.prototype.create_master_client = function(master_name, port, host, slaves, failover_timeout) {
    return new MasterClient( master_name, port, host, slaves, failover_timeout );
}

Monitor.prototype.select_current_sentinel = function(num_trials) {
    var self = this;

    num_trials = num_trials || 0;
    if (num_trials >= this.sentinel_clients.length) this.all_sentinels_down();

    this.current_sentinel = this.current_sentinel || this.sentinel_clients[0];

    this.current_sentinel.ping( function( error, response ) {
        if (!error) {
            self.subscribe_to_sentinel(self.current_sentinel);
            self.sentinel_selected();
            return;
        }
        var new_sentinel_index = (self.get_current_sentinel_index() + 1) % self.sentinel_clients.length;
        self.current_sentinel = self.sentinel_clients[new_sentinel_index];
        self.select_current_sentinel(num_trials + 1);
    });
};

Monitor.prototype.get_current_sentinel_index = function() {
    return this.sentinel_clients.indexOf(this.current_sentinel);
};

/**
 *  Subscribes to the given sentinel's pubsub events.
 *
 *  @param {RedisClient} sentinel_client The client object connected to the desired sentinel.
 */
Monitor.prototype.subscribe_to_sentinel = function(sentinel_client) {
    delete this.current_subscription;
    this.current_subscription = redis.createClient(sentinel_client.port, sentinel_client.host);
    this.current_subscription.subscribe('all');
    //sentinel.on('error', function(){});
    //sentinel.on('end', function(){});
    this.current_subscription.on('message', handle_sentinel_message.bind(this));
};

/**
 *  Requests list of masters from the sentinel and stores it.
 */
Monitor.prototype.load_master_list = function() {
    this.current_sentinel.send_command( 'sentinel', ['masters'], handle_master_list_response.bind(this));
};
function handle_master_list_response(err, response) {
    this.clusters_expected = response.length;
    for (var i = 0; i < response.length; i++) {
        var master_config = unflatten_hash(response[i]);
        this.masters[master_config.name] = master_config;
        this.master_config_loaded( master_config.name );
    }
}

/**
 *  For the named master instance, requests list of slaves from the sentinel and stores it.
 *
 *  @param {string} master_name The name of the redis cluster from which to request the slave list.
 */
Monitor.prototype.load_slave_list = function(master_name) {
    this.current_sentinel.send_command('sentinel', ['slaves', master_name], handle_slave_list_response.bind(this, master_name));
};
function handle_slave_list_response(master_name, err, response) {
    // TODO: handle error here
    if (this.slaves[master_name]) this.slaves[master_name].length = 0;
    else this.slaves[master_name] = [];
    
    for (var i = 0; i < response.length; i++) {
        this.slaves[master_name][i] = unflatten_hash(response[i]);
    }
    this.cluster_ready(master_name);
}

/**** Event emiter wrapper functions ****/
Monitor.prototype.all_sentinels_down = function() {
    this.emit('all_down');
};
Monitor.prototype.master_config_loaded = function(master_name) {
    this.emit('master_config_loaded', master_name);
};
Monitor.prototype.cluster_ready = function(master_name) {
    this.emit('cluster_ready', master_name);
};
Monitor.prototype.sync_complete = function() {
    this.emit('sync_complete');
};
Monitor.prototype.sentinel_selected = function() {
    this.emit('sentinel_selected');
}

/**** Utility Functions ****/
/**
 *  Calls the appropriate message handler for the sentinel channel on a publish event.
 */
function handle_sentinel_message (channel, message) {
    console.log(channel, message);
    if ( !(message && typeof message.data == 'string') ) return;

    var handler = this.SUBSCRIPTION_HANDLES[message['channel']];
    if ( typeof handler != 'function' ) return;
    handler( parse_instance_info(message['data']) );
}

/**
 *  Parses the space-delimited values returned by redis pubsub into a hash.
 *
 *  @param {string} info_str The string response from sentinel pubsub.
 *  @return {Object} The object hash mapping the values to what they represent on a redis instance.
 */
function parse_instance_info(infoStr) {
    var tokens = infoStr.split();
    var info = {
        type: tokens[0],
        name: tokens[1],
        host: tokens[2],
        port: tokens[3]
    };
    if (info.type == 'slave') info.master_name = tokens[5];
    return info;
}

/**
 *  Turns an array of sequential key value pairs into a hash
 *
 *  f/e: ['x', 2, 'y', 3] => { x: 2, y: 3 }
 *
 *  @param {Array} arr The array to be unflattened.
 *  @return {Object} The unflattened array.
 */
function unflatten_hash(arr) {
    var out = {};
    for (var i = 0; i < arr.length; i += 2) {
        out[arr[i]] = arr[i + 1];
    }
    return out;
}

