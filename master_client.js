var net = require('net');
var redis = require('redis');
var CommandQueue = require('./command_queue.js');

module.exports = MasterClient;
// Since this is an eventer, maybe use events to determine whether it enters failsafe
function MasterClient(master_name, master_port, master_host, slaves, timeout, options) {

    var self = this;
    this.name = master_name;
    this.failover_timeout = timeout || 5000;
    this.slaves = slaves;
    this.redis_client_options = options

    MasterClient.prototype.connect_to_redis_instance.call( this, master_port, master_host );

}

MasterClient.prototype.__proto__ = redis.RedisClient.prototype;

MasterClient.prototype.enter_failsafe_state = function(next) {
    var self = this;
    next = next || none;
    if (self.cq) return;
    self.generate_command_queue();
    self.connect_to_valid_slave(next);
    self.emit('+failsafe');
}

MasterClient.prototype.exit_failsafe_state = function(new_master_config) {
    var self = this;
    if (!self.cq) return;

    self.connect_to_redis_instance( new_master_config.port, new_master_config.host );
    self.consume_command_queue();
    self.emit('-failsafe');
}

MasterClient.prototype.connect_to_valid_slave = function(num_trials, next) {
    var self = this;
    var slaves = this.slaves;
    self.failsafe_state = 'rw';
    if (typeof num_trials == 'function') {
        next = num_trials;
        num_trials = 0;
    }
    num_trials = num_trials || 0;

    // using the square of num slaves as the upper bound for number of random slaves
    // to try.
    if (num_trials < slaves.length * slaves.length) {
        var slave = slaves[Math.floor(Math.random() * slaves.length)];
        this.connect_to_redis_instance( slave.port, slave.ip );
        this.ping( function(error, response) {
            if (error) self.connect_to_valid_slave(num_trials + 1, next);
            else self.failsafe_state = 'w';
        });
    }
    next();
}

MasterClient.prototype.connect_to_redis_instance = function( port, host ) {
    var net_client = net.createConnection(port, host);
    redis.RedisClient.call(this, net_client, this.redis_client_options);
    this.port = port;
    this.host = host;
}

MasterClient.prototype.super_send_command = redis.RedisClient.prototype.send_command;
MasterClient.prototype.send_command = function(command, args, next, trials) {
    trials = trials || 0;
    if (typeof args[-1] == 'function') next = args[-1];
    else if (typeof next != 'function') next = function(){};

    if (this.cq) this.send_command_with_failsafe(command, args, next, trials);
    else this.send_command_without_failsafe(command, args, next, trials);
}

MasterClient.prototype.send_command_with_failsafe = function(command, args, next, trials) {
    var self = this;
    //console.info('sending command with failsafe');
    if (is_write_command(command) || self.failsafe_state == 'rw')
        return self.cq[command](args, next);

    self.super_send_command(command, args, function(error, response) {
        if (error) self.connect_to_valid_slave( 0, function() {
            self.send_command(command, args, next);
        });
        else next(error, response); 
    });
}

MasterClient.prototype.send_command_without_failsafe = function(command, args, next, trials) {
    //console.info('sending command without failsafe');
    var self = this;
    self.super_send_command(command, args, function( error, response ) {
        // TODO: how many trials will we allow before deciding the process has failed beyond recovery?
        if (error && !trials) {
            return self.enter_failsafe_state( function() {
                self.send_command(command, args, next);
            });
        }
        else if (error) return self.send_command(command, args, next, trials + 1);

        next(error, response);
    });
}

MasterClient.prototype.generate_command_queue = function() {
    this.cq = new CommandQueue(this);
}
MasterClient.prototype.consume_command_queue = function() {
    var cq = this.cq;
    delete this.cq;
    cq.exec();
}

function none(){}

function is_write_command(command) {
    return /(pop)|(set)|(del)/i.test(command);
}
