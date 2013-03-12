// TODO: Replace multi so we dont end up throwing away callbacks
// alternatively, store callbacks for when we exec multi
var net = require('net');
var redis = require('redis');

module.exports = NegotiatorClient;
// Since this is an eventer, maybe use events to determine whether it enters failsafe
function NegotiatorClient(master_name, master_port, master_host, slaves) {

    var self = this;
    this.name = master_name;

    /*
    this.enter_failsafe_state = enter_failsafe_state;
    this.exit_failsafe_state = exit_failsafe_state;
    this.connect_to_valid_slave = connect_to_valid_slave;
    this.connect_to_redis_instance = connect_to_redis_instance;
    this.super_send_command = redis.RedisClient.prototype.send_command;
    this.send_command = send_negotiated_command;
    */

    NegotiatorClient.prototype.connect_to_redis_instance.call( this, master_port, master_host );

}

NegotiatorClient.prototype.__proto__ = redis.RedisClient.prototype;

NegotiatorClient.prototype.enter_failsafe_state = function() {
    var self = this;
    console.info('ENTERING FAILSAFE STATE FOR: ', self.name);
    if (self.pipeline) return;
    // gets connection to arbitrary slave.  need to make sure slave works for reads. 
    self.connect_to_valid_slave();
    self.pipeline = self.multi();
}

NegotiatorClient.prototype.exit_failsafe_state = function(new_master_config) {
    var self = this;
    console.info('exiting failsage state');
    if (!self.pipeline) return;

    new_master_config = new_master_config || {port: master_port, host: master_host};
    self.connect_to_redis_instance( new_master_config.port, new_master_config.host );
    pipeline.exec( function(error, responses) {
        if (!error) {
            delete self.pipeline;
            self.failsafe_state = '';
        }
    });
}

NegotiatorClient.prototype.connect_to_valid_slave = function(num_trials, next) {
    var self = this;
    self.failsafe_state = 'rw';
    num_trials = num_trials || 0;

    // using the square of num slaves as the upper bound for number of random slaves
    // to try.
    if (num_trials < slaves.length * slaves.length) {
        var slave = slaves[Math.floor(Math.rand() * slaves.length)];
        this.connect_to_redis_instance( slave.port, slave.host );
        this.ping( function(error, response) {
            if (error) self.connect_to_valid_slave(num_trials + 1);
            self.failsafe_state = 'w';
        });
    }
    next();
}

NegotiatorClient.prototype.connect_to_redis_instance = function( port, host ) {
    var net_client = net.createConnection(port, host);
    redis.RedisClient.call(this, net_client); // has potential options arg which currently isnt in use

}

NegotiatorClient.prototype.send_negotiated_command = function(command, args, next, trials) {
    console.info('negotiated command args: ', command, args);
    trials = trials || 0;
    if (typeof next != 'function') next = function(){};

    if (this.pipeline) this.send_command_with_failsafe(command, args, next, trials);
    else this.send_command_without_failsafe(command, args, next, trials);

}

NegotiatorClient.prototype.send_command_with_failsafe = function(command, args, next, trials) {
    var self = this;
    console.info('sending command with failsafe');
    if (is_write_command(command) || self.failsafe_state == 'rw')
        return self.pipeline[command](args, next);

    self.super_send_command(command, args, function(error, response) {
        if (error) connect_to_valid_slave( 0, function() {
            self.send_command(command, args, next);
        });
        else next(error, response); 
    });
}

NegotiatorClient.prototype.send_command_without_failsafe = function(command, args, next, trials) {
    console.info('sending command without failsafe');
    var self = this;
    self.super_send_command(command, args, function( error, response ) {
        // TODO: how many trials will we allow before deciding the process has failed beyond recovery?
        if (error && !trials) {
            enter_failsafe_state();
            return self.send_command(command, args, next);
        }
        if (error) return self.send_command(command, args, next, trials + 1);

        next(error, response);
    });
}

function is_write_command(command) {
    return /(pop)|(set)|(del)/i.test(command);
}
