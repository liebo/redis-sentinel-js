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
 *      options.hosts => a string indicating the host:port to connect to
 *      options.timeout => the timeout for queued requests wating for failover to finish
 */
function Monitor( options ) {

    EventEmitter.call(this);

    var defaults = {
        hosts: ['localhost:23679'],
        failover_timeout: 5000
    };

    var settings = {};
    _.extend(settings, defaults, options);
    this.options = settings;

    this.sentinel_client = null;
    this.master_clients = {};

    this.sentinels = [];
    this.masters = {};
    this.slaves = {};

    this.current_sentinel = null;
    this.current_subscription = null;

    this.clusters_expected = 0;
    this.clusters_loaded = 0;

    for (var hosts_index in settings.hosts) {
        var host_and_port = settings.hosts[hosts_index].split(':');
        this.add_sentinel(parseInt(host_and_port[1]), host_and_port[0], true);
    }

    // Connects to a random sentinel. TODO: robustness;
    //var sentinel_to_connect_to = parseInt(Math.random() * settings.hosts.length);
    this.sentinel_client = this.connect_to_sentinel(0);

    //**** EVENTS ****//
    this.on('sentinel_selected', this.load_master_list);
    this.on('master_config_loaded', this.load_slave_list);
    this.on('cluster_ready', this.cluster_config_loaded);

};

Monitor.prototype.sync = function() {
    this.clusters_expected = 0;
    this.clusters_loaded = 0;
    this.select_current_sentinel();
};

Monitor.prototype.__proto__ = EventEmitter.prototype;

/**
 * Returns the master client abstraction used to maintain high availability
 * connection to the redis cluster. If a MasterClient exists by the given
 * name, return that client.  Else create one and store it in the 'clients' hash.
 *
 * @param {string} master_name The name given to the cluster by the sentinels.
 * @return {MasterClient} The requested MasterClient.
 */
Monitor.prototype.get_client = function(master_name) {
    var mc = this.master_clients[master_name];

    if (mc) return mc;

    var config = this.masters[master_name];
    if (!config) throw new Error("Sentinels cannot find master: " + master_name);

    var port = parseInt(config.port);
    var host = config.ip;
    var slaves = this.slaves[master_name];
    var timeout = this.failover_timeout;
    mc = this.create_master_client(master_name, port, host, slaves, timeout);
    this.master_clients[master_name] = mc;
    return mc;
};

/**
 * Creates a MasterClient instance. Overridden in test.
 */
Monitor.prototype.create_master_client = function(master_name, port, host, slaves, failover_timeout) {
    return new MasterClient( master_name, port, host, slaves, failover_timeout );
};

/**
 * Sets the current sentinel to the first active sentinel provided by
 * the options argument.
 */
Monitor.prototype.select_current_sentinel = function(num_trials) {
    var self = this;

    num_trials = num_trials || 0;
    if (num_trials >= this.sentinels.length) this.all_sentinels_down();

    if (!this.sentinel_client) this.connect_to_sentinel(0);

    this.sentinel_client.ping( function( error ) {
        if (!error) {
            self.subscribe_to_sentinel(self.current_sentinel);
            self.sentinel_selected();
            return;
        }
        var new_sentinel_index = (self.get_current_sentinel_index() + 1) % self.sentinels.length;
        self.connect_to_sentinel(new_sentinel_index);
        self.select_current_sentinel(num_trials + 1);
    });
};

Monitor.prototype.connect_to_sentinel = function(index) {
    var config = this.sentinels[index],
        port = config.port,
        host = config.host;
    this.current_sentinel = config;
    this.sentinel_client = redis.createClient(port, host);
    return this.sentinel_client;
}

Monitor.prototype.get_current_sentinel_index = function() {
    var cs = this.current_sentinel;
    return this.get_sentinel_index(cs.port, cs.host);
};
Monitor.prototype.get_sentinel_index = function(port, host) {
    var index = -1;
    this.sentinels.forEach(function(sentinel, s_index) {
        if (sentinel.port == port && sentinel.host == host) index = s_index;
    })
    return index;
}

/**
 *  Subscribes to the given sentinel's pubsub events.
 *
 *  @param {RedisClient} sentinel_client The client object connected to the desired sentinel.
 */
Monitor.prototype.subscribe_to_sentinel = function(sentinel_client) {
    delete this.current_subscription;

    this.current_subscription = redis.createClient(sentinel_client.port, sentinel_client.host);
    this.current_subscription.psubscribe('*');
    //sentinel.on('error', function(){});
    //sentinel.on('end', function(){});
    this.current_subscription.on('pmessage', handle_sentinel_message.bind(this));
};

/**
 *  Requests list of masters from the sentinel and stores it.
 */
Monitor.prototype.load_master_list = function() {
    this.sentinel_client.send_command( 'sentinel', ['masters'], handle_master_list_response.bind(this));
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
    this.sentinel_client.send_command('sentinel', ['slaves', master_name], handle_slave_list_response.bind(this, master_name));
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

Monitor.prototype.cluster_config_loaded = function() {
    this.clusters_loaded++;
    if (this.clusters_loaded == this.clusters_expected) this.sync_complete();
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
    this.synced = true;
    this.emit('synced');
};
Monitor.prototype.sentinel_selected = function() {
    this.emit('sentinel_selected');
};

/**** Recovery Event Handlers ****/
Monitor.prototype.on_obj_down = function(info) {
    if (info.type == 'master') this.get_client(info.name).enter_failsafe_state();
    else {
        // TODO: handle sentinels and slaves--nothing to do here yet
        // if save is down, remove it from the list of configs. If sentinel is down, do the same
    }
}

Monitor.prototype.on_obj_up = function(info) {
    if (info.type == 'master') this.get_client(info.name).exit_failsafe_state();
    else {
        // TODO: handle sentinels and slaves--nothing to do here yet
    }
}

// change these for different behavior on +-subdown
Monitor.prototype.on_sub_down = function(info) {
    this.on_obj_down(info);
}
Monitor.prototype.on_sub_up = function(info) {
    this.on_obj_up(info);
}

Monitor.prototype.on_new_slave = function(info) {
    this.load_slave_list(info.master_name);
}

Monitor.prototype.on_new_sentinel = function(info) {
    this.add_sentinel(info.port, info.host);
}

Monitor.prototype.on_reboot_instance = function(info) {}

Monitor.prototype.add_sentinel = function(port, host, skip_check_if_exists) {
    if ( skip_check_if_exists || !(1+this.get_sentinel_index(port, host)) ) {
        this.sentinels.push({port: port, host: host});
    }
}

Monitor.prototype.on_switch_master = function(){}

Monitor.prototype.SUBSCRIPTION_HANDLES = {
    '+sdown': this.on_sub_down,
    '-sdown': this.on_sub_up,
    '+odown': this.on_obj_down,
    '-odown': this.on_obj_up,
    '+sentinel': this.on_new_sentinel,
    '+slave': this.on_new_slave,
    '+switch-master': this.on_switch_master,
    '+reboot': this.on_reboot_instance
};

/**** Utility Functions ****/
/**
 *  Calls the appropriate message handler for the sentinel channel on a publish event.
 *
 *  NOTE: the pattern param is a placeholder and is not being used at all
 */
function handle_sentinel_message(pattern, channel, message) {
    if ( !(message && typeof message.data == 'string') ) return;

    var handler = this.SUBSCRIPTION_HANDLES[channel];
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

